import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { slackRelayConfig } from '@claw/shared-config/slack-relay';
import { verifySlackSignature } from './verify-signature.js';

const startedAt = Date.now();

const app = Fastify({
  logger: process.env.NODE_ENV === 'test'
    ? false
    : {
        level: 'info',
        transport: process.env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty' }
          : undefined,
        base: { service: 'slack-relay' },
      },
  genReqId: () => crypto.randomUUID(),
});

// ─── Raw body capture (required for Slack signature verification) ─────────────

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

app.addHook('preParsing', async (req, _reply, payload) => {
  const chunks: Buffer[] = [];
  for await (const chunk of payload as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  req.rawBody = raw;
  return Readable.from(Buffer.from(raw));
});

// ─── Slack event types ────────────────────────────────────────────────────────

export interface SlackEventEnvelope {
  type: string;
  challenge?: string;
  team_id?: string;
  event?: {
    user?: string;
    type?: string;
    text?: string;
    channel?: string;
    ts?: string;
    event_ts?: string;
  };
  event_id?: string;
  event_time?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function computeTenantId(slackTeamId: string, slackUserId: string): string {
  return createHash('sha256')
    .update(`${slackTeamId}:${slackUserId}`)
    .digest('hex')
    .slice(0, 16);
}

export async function postSlackDm(
  userId: string,
  text: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  // Open DM channel with user
  const openRes = await fetchFn('https://slack.com/api/conversations.open', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ users: userId }),
  });
  const openBody = await openRes.json() as { ok: boolean; channel?: { id: string } };
  if (!openBody.ok || !openBody.channel?.id) return;

  await fetchFn('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel: openBody.channel.id, text }),
  });
}

const ACTIVE_POLL_INTERVAL_MS = 2000;
const ACTIVE_WAIT_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
const INTERIM_DELAY_MS = 15_000;               // 15 seconds
const MAX_DELIVERY_MS = 4 * 60 * 1000;         // 4 minutes

export async function processSlackEvent(
  envelope: SlackEventEnvelope,
  log: typeof app.log,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const slackTeamId = envelope.team_id ?? '';
  const slackUserId = envelope.event?.user ?? '';
  const slackEventId = envelope.event_id ?? '';
  const channel = envelope.event?.channel ?? slackUserId;

  if (!slackTeamId || !slackUserId) {
    log.warn({ envelope }, 'Slack event missing team_id or user');
    return;
  }

  const cpBase = slackRelayConfig.CONTROL_PLANE_URL;

  // Step 1: Provision tenant — control plane checks allowlist, returns 403 if denied
  const provisionRes = await fetchFn(`${cpBase}/v1/tenants/provision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slackTeamId, slackUserId }),
  });

  if (provisionRes.status === 403) {
    log.warn({ slackTeamId, slackUserId }, 'ACCESS_DENIED: user not on allowlist');
    await postSlackDm(
      slackUserId,
      'Thanks for your interest! This system is currently invite-only. Contact [admin contact] to request access.',
      slackRelayConfig.SLACK_BOT_TOKEN,
      fetchFn,
    );
    return;
  }

  if (!provisionRes.ok) {
    const errBody = await provisionRes.json() as { error?: string };
    log.error({ slackTeamId, slackUserId, status: provisionRes.status, error: errBody.error }, 'Provision failed');
    return;
  }

  const provisionBody = await provisionRes.json() as { tenantId: string; status: string; relayToken: string };
  const { tenantId, relayToken } = provisionBody;
  let currentStatus = provisionBody.status;

  // Step 2: Wake tenant if not already active or starting
  if (currentStatus !== 'ACTIVE' && currentStatus !== 'STARTING') {
    try {
      await fetchFn(`${cpBase}/v1/tenants/${tenantId}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
    } catch (err) {
      log.warn({ err, tenantId }, 'Failed to start tenant; continuing');
    }
  }

  // Step 3: Poll until tenant becomes ACTIVE (up to 3 minutes)
  if (currentStatus !== 'ACTIVE') {
    const deadline = Date.now() + ACTIVE_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(Math.min(ACTIVE_POLL_INTERVAL_MS, deadline - Date.now()));
      const pollRes = await fetchFn(`${cpBase}/v1/tenants/provision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slackTeamId, slackUserId }),
      });
      if (pollRes.ok) {
        const pollBody = await pollRes.json() as { status: string };
        currentStatus = pollBody.status;
        if (currentStatus === 'ACTIVE') break;
      }
    }

    if (currentStatus !== 'ACTIVE') {
      log.warn({ tenantId }, 'Tenant did not become ACTIVE within 3 minutes');
      await postSlackDm(slackUserId, 'Your workspace is starting, please wait a moment and try again.', slackRelayConfig.SLACK_BOT_TOKEN, fetchFn);
      return;
    }
  }

  // Step 4: Forward message with relay token; 15s interim + 4-min hard timeout
  const msgPayload = {
    messageId: crypto.randomUUID(),
    slackEventId,
    userId: slackUserId,
    teamId: slackTeamId,
    text: envelope.event?.text ?? '',
    slackPayload: envelope as unknown as Record<string, unknown>,
    timestamp: Date.now(),
  };

  const controller = new AbortController();
  let interimSent = false;

  // 15-second interim timer: notify user we're working on it
  const interimTimer = setTimeout(() => {
    interimSent = true;
    void postSlackDm(slackUserId, '⏳ Working on it...', slackRelayConfig.SLACK_BOT_TOKEN, fetchFn);
  }, INTERIM_DELAY_MS);

  const deliveryTimer = setTimeout(() => controller.abort(), MAX_DELIVERY_MS);

  try {
    const msgRes = await fetchFn(`${cpBase}/v1/tenants/${tenantId}/message`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-relay-token': relayToken,
      },
      body: JSON.stringify(msgPayload),
      signal: controller.signal,
    });

    clearTimeout(interimTimer);
    clearTimeout(deliveryTimer);

    if (msgRes.ok) {
      const msgBody = await msgRes.json() as { ok?: boolean; response?: string; blocks?: unknown[] | null };
      if (msgBody.ok) {
        if (msgBody.blocks != null && Array.isArray(msgBody.blocks)) {
          await fetchFn('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${slackRelayConfig.SLACK_BOT_TOKEN}` },
            body: JSON.stringify({ channel, blocks: msgBody.blocks }),
          });
        } else if (msgBody.response) {
          await fetchFn('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${slackRelayConfig.SLACK_BOT_TOKEN}` },
            body: JSON.stringify({ channel, text: msgBody.response }),
          });
        }
      }
    }
  } catch (err) {
    clearTimeout(interimTimer);
    clearTimeout(deliveryTimer);

    if (!interimSent) {
      // Delivery aborted by 4-minute timeout
      await postSlackDm(slackUserId, "I'm still working on this. I'll follow up when complete.", slackRelayConfig.SLACK_BOT_TOKEN, fetchFn);
    }

    log.warn({ err, tenantId, slackEventId }, 'Failed to forward message to tenant');
  }

  log.info({ tenantId, slackEventId }, 'Slack event processed');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Health route ─────────────────────────────────────────────────────────────

app.get('/health', async (_req, reply) => {
  return reply.send({ ok: true, uptime: Date.now() - startedAt });
});

// ─── Slack events endpoint ───────────────────────────────────────────────────

app.post<{ Body: SlackEventEnvelope }>('/slack/events', async (req, reply) => {
  // Verify Slack signature
  const isValid = verifySlackSignature(
    req.rawBody ?? '',
    {
      'x-slack-signature': req.headers['x-slack-signature'] as string | undefined,
      'x-slack-request-timestamp': req.headers['x-slack-request-timestamp'] as string | undefined,
    },
    slackRelayConfig.SLACK_SIGNING_SECRET,
  );

  if (!isValid) {
    return reply.status(403).send({ error: 'Invalid signature' });
  }

  const body = req.body;

  // Handle Slack URL verification challenge synchronously
  if (body.type === 'url_verification') {
    return reply.send({ challenge: body.challenge });
  }

  // Fire-and-forget: return 200 immediately, process event asynchronously.
  // This satisfies Slack's 3-second response timeout requirement (AC #1, #8).
  void processSlackEvent(body, req.log).catch((err) => {
    req.log.error({ err }, 'Error processing Slack event');
  });

  return reply.send({});
});

// ─── Startup sweep ────────────────────────────────────────────────────────────

async function startupSweep(): Promise<void> {
  // Reset any PROCESSING message_queue rows older than 2 minutes.
  // The control plane handles this internally; for the relay, we log a note.
  app.log.info({ service: 'slack-relay' }, 'Startup sweep: PROCESSING messages reset by control plane on its startup');
}

// ─── Server startup ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await startupSweep();

  await app.listen({
    port: slackRelayConfig.SLACK_RELAY_PORT,
    host: '0.0.0.0',
  });

  app.log.info(
    { service: 'slack-relay', port: slackRelayConfig.SLACK_RELAY_PORT },
    'Slack relay started',
  );
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  app.log.info({ service: 'slack-relay' }, 'Shutting down...');
  await app.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

// Only start the server when this module is run directly (not imported in tests)
if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}

import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { slackRelayConfig } from '@claw/shared-config/slack-relay';
import { verifySlackSignature } from './verify-signature.js';

const startedAt = Date.now();

const app = Fastify({
  logger: {
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

interface SlackEventEnvelope {
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

function computeTenantId(slackTeamId: string, slackUserId: string): string {
  return createHash('sha256')
    .update(`${slackTeamId}:${slackUserId}`)
    .digest('hex')
    .slice(0, 16);
}

async function postSlackDm(userId: string, text: string): Promise<void> {
  // Open DM channel with user
  const openRes = await fetch('https://slack.com/api/conversations.open', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${slackRelayConfig.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ users: userId }),
  });
  const openBody = await openRes.json() as { ok: boolean; channel?: { id: string } };
  if (!openBody.ok || !openBody.channel?.id) return;

  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${slackRelayConfig.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel: openBody.channel.id, text }),
  });
}

async function processSlackEvent(
  envelope: SlackEventEnvelope,
  log: typeof app.log,
): Promise<void> {
  const slackTeamId = envelope.team_id ?? '';
  const slackUserId = envelope.event?.user ?? '';
  const slackEventId = envelope.event_id ?? '';

  if (!slackTeamId || !slackUserId) {
    log.warn({ envelope }, 'Slack event missing team_id or user');
    return;
  }

  const tenantId = computeTenantId(slackTeamId, slackUserId);

  // Provision tenant (allowlist check happens inside provision endpoint)
  const provisionRes = await fetch(
    `${slackRelayConfig.CONTROL_PLANE_URL}/v1/tenants/provision`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slackTeamId, slackUserId }),
    },
  );

  if (provisionRes.status === 403) {
    log.warn({ slackTeamId, slackUserId, tenantId }, 'Access denied by allowlist');
    await postSlackDm(
      slackUserId,
      "Thanks for your interest! This system is currently invite-only. Contact [admin contact] to request access.",
    );
    return;
  }

  if (!provisionRes.ok) {
    const body = await provisionRes.json() as { error?: string };
    log.error({ tenantId, status: provisionRes.status, error: body.error }, 'Provision failed');
    return;
  }

  // Start tenant if not already active
  await fetch(
    `${slackRelayConfig.CONTROL_PLANE_URL}/v1/tenants/${tenantId}/start`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    },
  );

  // Forward message to tenant (control plane queues it if not ACTIVE)
  const msgPayload = {
    slackEventId,
    slackTeamId,
    slackUserId,
    text: envelope.event?.text ?? '',
    channel: envelope.event?.channel ?? '',
    timestamp: envelope.event?.ts ?? String(envelope.event_time ?? Date.now()),
  };

  const msgRes = await fetch(
    `${slackRelayConfig.CONTROL_PLANE_URL}/v1/tenants/${tenantId}/message`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Relay token is stored in the tenant row; we use a system token here
        // The control plane validates it on delivery
      },
      body: JSON.stringify(msgPayload),
    },
  );

  if (msgRes.ok) {
    const msgBody = await msgRes.json() as { ok: boolean; response?: string };
    if (msgBody.ok && msgBody.response) {
      // Post agent's response back to the Slack channel
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${slackRelayConfig.SLACK_BOT_TOKEN}`,
        },
        body: JSON.stringify({
          channel: envelope.event?.channel ?? '',
          text: msgBody.response,
        }),
      });
    }
  }

  log.info({ tenantId, slackEventId }, 'Slack event processed');
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

  // Fire-and-forget: return 200 immediately, process event asynchronously
  // This satisfies Slack's 3-second response timeout requirement
  void processSlackEvent(body, req.log).catch((err) => {
    req.log.error({ err }, 'Error processing Slack event');
  });

  return reply.send({});
});

// ─── Server startup ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
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

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

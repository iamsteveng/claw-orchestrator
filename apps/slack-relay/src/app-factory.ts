/**
 * Factory function for the Slack relay Fastify app.
 * Accepts an explicit config object so tests can inject overrides
 * (e.g., a different CONTROL_PLANE_URL pointing to a test instance).
 *
 * Optionally accepts a PrismaClient for message queue management
 * (enqueue message before delivery, mark DELIVERED on success).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { SlackRelayConfig } from '@claw/shared-config/slack-relay';
import type { PrismaClient } from '@prisma/client';

// Augment Fastify request type to include rawBody (needed for signature verification)
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

const MAX_TIMESTAMP_AGE_SECONDS = 5 * 60; // 5 minutes

// ─── Slack event types ─────────────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────

type Logger = { error: (ctx: object, msg: string) => void };

export async function postSlackDm(
  userId: string,
  text: string,
  token: string,
  fetchFn: typeof fetch = fetch,
  log?: Logger,
): Promise<void> {
  const openRes = await fetchFn('https://slack.com/api/conversations.open', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ users: userId }),
  });
  const openBody = await openRes.json() as { ok: boolean; channel?: { id: string }; error?: string };
  if (!openBody.ok || !openBody.channel?.id) {
    log?.error({ userId, slackError: openBody.error }, 'Failed to send Slack DM: conversations.open failed');
    return;
  }

  const postRes = await fetchFn('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel: openBody.channel.id, text }),
  });
  const postBody = await postRes.json() as { ok: boolean; error?: string };
  if (!postBody.ok) {
    log?.error({ userId, slackError: postBody.error }, 'Failed to send Slack DM: chat.postMessage failed');
  }
}

const ACTIVE_POLL_INTERVAL_MS = 2000;
const ACTIVE_WAIT_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
const INTERIM_DELAY_MS = 15_000;               // 15 seconds
const MAX_DELIVERY_MS = 4 * 60 * 1000;         // 4 minutes

export async function processSlackEventWithConfig(
  envelope: SlackEventEnvelope,
  config: SlackRelayConfig,
  log: { warn: (ctx: object, msg: string) => void; error: (ctx: object, msg: string) => void; info: (ctx: object, msg: string) => void },
  fetchFn: typeof fetch = fetch,
  prisma?: PrismaClient,
): Promise<void> {
  const slackTeamId = envelope.team_id ?? '';
  const slackUserId = envelope.event?.user ?? '';
  const slackEventId = envelope.event_id ?? '';
  const channel = envelope.event?.channel ?? slackUserId;

  if (!slackTeamId || !slackUserId) {
    log.warn({ envelope }, 'Slack event missing team_id or user');
    return;
  }

  const cpBase = config.CONTROL_PLANE_URL;

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
      config.SLACK_BOT_TOKEN,
      fetchFn,
      log,
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
  const wasAlreadyActive = currentStatus === 'ACTIVE';
  if (!wasAlreadyActive) {
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
      await postSlackDm(slackUserId, 'Your workspace is starting, please wait a moment and try again.', config.SLACK_BOT_TOKEN, fetchFn, log);
      return;
    }

    // Send welcome DM now that workspace is ready for the first time
    await postSlackDm(slackUserId, 'Your workspace is ready! You can start chatting now.', config.SLACK_BOT_TOKEN, fetchFn, log);
  }

  // Step 4: Enqueue the message (PENDING) if prisma is available
  let messageQueueId: string | undefined;
  if (prisma && slackEventId) {
    const now = Date.now();
    const payload = JSON.stringify({
      slackTeamId,
      slackUserId,
      slackEventId,
      text: envelope.event?.text ?? '',
      channel,
      envelope,
    });
    try {
      const row = await prisma.messageQueue.create({
        data: {
          id: randomUUID(),
          tenant_id: tenantId,
          slack_event_id: slackEventId,
          slack_channel_id: channel,
          payload,
          status: 'PENDING',
          attempts: 0,
          created_at: now,
          updated_at: now,
        },
      });
      messageQueueId = row.id;
    } catch (err) {
      // Check if this is a duplicate slackEventId (idempotency) or a real error
      const existing = await prisma.messageQueue.findUnique({
        where: { slack_event_id: slackEventId },
      });
      if (existing) {
        messageQueueId = existing.id;
      } else {
        log.error({ err, tenantId, slackEventId }, 'Failed to enqueue message in Prisma');
      }
    }
  }

  // Step 5: Forward message with relay token; 15s interim + 4-min hard timeout
  const msgPayload = {
    messageId: crypto.randomUUID(),
    slackEventId,
    userId: slackUserId,
    teamId: slackTeamId,
    text: envelope.event?.text ?? '',
    slackPayload: envelope as unknown as Record<string, unknown>,
    timestamp: Date.now(),
  };

  let deliveryTimerId: ReturnType<typeof setTimeout> | undefined;

  // 15-second interim timer: notify user we're working on it
  const interimTimer = setTimeout(() => {
    void postSlackDm(slackUserId, '⏳ Working on it...', config.SLACK_BOT_TOKEN, fetchFn, log);
  }, INTERIM_DELAY_MS);

  // Mark message as PROCESSING before forwarding
  if (prisma && messageQueueId) {
    try {
      await prisma.messageQueue.update({
        where: { id: messageQueueId },
        data: { status: 'PROCESSING', updated_at: Date.now() },
      });
    } catch { /* best-effort */ }
  }

  try {
    const fetchPromise = fetchFn(`${cpBase}/v1/tenants/${tenantId}/message`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-relay-token': relayToken,
      },
      body: JSON.stringify(msgPayload),
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      deliveryTimerId = setTimeout(
        () => reject(Object.assign(new Error('Message delivery timed out'), { name: 'AbortError' })),
        MAX_DELIVERY_MS,
      );
    });

    const msgRes = await Promise.race([fetchPromise, timeoutPromise]);

    clearTimeout(interimTimer);
    clearTimeout(deliveryTimerId);

    if (!msgRes.ok) {
      let errBody: unknown;
      try { errBody = await msgRes.json(); } catch { /* ignore parse error */ }
      log.error({ tenantId, slackEventId, status: msgRes.status, body: errBody }, 'CP message endpoint returned non-2xx');
      await postSlackDm(slackUserId, 'I received your message but had trouble generating a response. Please try again.', config.SLACK_BOT_TOKEN, fetchFn, log);
    } else if (msgRes.ok) {
      const msgBody = await msgRes.json() as { ok?: boolean; response?: string; blocks?: unknown[] | null };

      // Mark DELIVERED: CP returned 200 = message was forwarded to the container runtime
      if (prisma && messageQueueId) {
        try {
          await prisma.messageQueue.update({
            where: { id: messageQueueId },
            data: { status: 'DELIVERED', updated_at: Date.now() },
          });
        } catch { /* best-effort */ }
      }

      if (msgBody.ok) {
        if (msgBody.blocks != null && Array.isArray(msgBody.blocks)) {
          await fetchFn('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${config.SLACK_BOT_TOKEN}` },
            body: JSON.stringify({ channel, blocks: msgBody.blocks }),
          });
        } else if (msgBody.response) {
          await fetchFn('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${config.SLACK_BOT_TOKEN}` },
            body: JSON.stringify({ channel, text: msgBody.response }),
          });
        } else {
          await postSlackDm(slackUserId, 'I received your message but had trouble generating a response. Please try again.', config.SLACK_BOT_TOKEN, fetchFn, log);
        }
      }
    }
  } catch (err) {
    clearTimeout(interimTimer);
    clearTimeout(deliveryTimerId);
    await postSlackDm(slackUserId, "I'm still working on this. I'll follow up when complete.", config.SLACK_BOT_TOKEN, fetchFn, log);
    log.error({ err, tenantId, slackEventId }, 'Failed to forward message to tenant');
  }

  log.info({ tenantId, slackEventId }, 'Slack event processed');
}

function verifySlackSignatureLocal(
  rawBody: string,
  headers: { 'x-slack-signature'?: string; 'x-slack-request-timestamp'?: string },
  signingSecret: string,
): boolean {
  const timestamp = headers['x-slack-request-timestamp'];
  const signature = headers['x-slack-signature'];

  if (!timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (isNaN(ts)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_TIMESTAMP_AGE_SECONDS) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = createHmac('sha256', signingSecret);
  hmac.update(baseString);
  const computed = `v0=${hmac.digest('hex')}`;

  const computedBuf = Buffer.from(computed, 'utf8');
  const sigBuf = Buffer.from(signature, 'utf8');

  if (computedBuf.length !== sigBuf.length) return false;

  return timingSafeEqual(computedBuf, sigBuf);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds a Fastify slack-relay instance with an explicit config object.
 * Useful in tests: pass a config with CONTROL_PLANE_URL pointing to a test server.
 *
 * @param config - Slack relay configuration (CONTROL_PLANE_URL, signing secret, etc.)
 * @param fetchFn - fetch function (can be mocked in tests)
 * @param prisma - optional PrismaClient for message queue management
 */
export async function buildSlackRelayApp(
  config: SlackRelayConfig,
  fetchFn: typeof fetch = fetch,
  prisma?: PrismaClient,
): Promise<FastifyInstance> {
  const startedAt = Date.now();

  const app = Fastify({
    logger: false,
    genReqId: () => crypto.randomUUID(),
  });

  // ─── Raw body capture (required for Slack signature verification) ──────────

  app.addHook('preParsing', async (req, _reply, payload) => {
    const chunks: Buffer[] = [];
    for await (const chunk of payload as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    req.rawBody = raw;
    return Readable.from(Buffer.from(raw));
  });

  // ─── Health route ──────────────────────────────────────────────────────────

  app.get('/health', async (_req, reply) => {
    return reply.send({ ok: true, uptime: Date.now() - startedAt });
  });

  // ─── Slack events endpoint ─────────────────────────────────────────────────

  app.post<{ Body: SlackEventEnvelope }>('/slack/events', async (req, reply) => {
    const isValid = verifySlackSignatureLocal(
      req.rawBody ?? '',
      {
        'x-slack-signature': req.headers['x-slack-signature'] as string | undefined,
        'x-slack-request-timestamp': req.headers['x-slack-request-timestamp'] as string | undefined,
      },
      config.SLACK_SIGNING_SECRET,
    );

    if (!isValid) {
      return reply.status(403).send({ error: 'Invalid signature' });
    }

    const body = req.body;

    if (body.type === 'url_verification') {
      return reply.send({ challenge: body.challenge });
    }

    // Fire-and-forget: return 200 immediately
    void processSlackEventWithConfig(body, config, req.log, fetchFn, prisma).catch((err) => {
      req.log.error({ err }, 'Error processing Slack event');
    });

    return reply.send({});
  });

  return app;
}

/**
 * TC-006: Allowlist enforcement → unauthorized user rejected
 *
 * End-to-end test verifying that a Slack user NOT on the allowlist is rejected:
 * - Relay returns HTTP 200 immediately (Slack ack)
 * - Control plane returns 403 on /v1/tenants/provision
 * - No tenant row created for this user
 * - Slack chat.postMessage called with invite-only rejection message
 * - ACCESS_DENIED audit log entry exists (tenant_id=null)
 *
 * Uses a private DATA_DIR (/tmp/claw-tc006-isolated) to avoid interference from
 * other e2e test files running concurrently.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { randomUUID, createHmac } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { buildApp as BuildAppFn } from '../../apps/control-plane/src/app-factory.js';
import type { buildSlackRelayApp as BuildRelayFn } from '../../apps/slack-relay/src/app-factory.js';

// Mock Date.now() to small incrementing counter to avoid SQLite Int32 overflow.
let mockNow = 8_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_TEAM_ID = 'T_BLOCKED';
const TEST_USER_ID = 'U_BLOCKED';
const SIGNING_SECRET = 'test-signing-secret-tc006';
const BOT_TOKEN = 'xoxb-test-token-tc006';

// Private data dir — completely separate from shared /tmp/claw-test-tenants
const TEST_DATA_DIR = '/tmp/claw-tc006-isolated';

// Ports distinct from other e2e tests
// TC-001: 13307/13308, TC-002: 13309/13310, TC-003: 13311/13312,
// TC-004: 13313/13314, TC-005: 13315, TC-006: 13317/13318
const CP_PORT = 13317;
const RELAY_PORT = 13318;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSlackHeaders(body: string, secret = SIGNING_SECRET) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = createHmac('sha256', secret);
  hmac.update(baseString);
  const signature = `v0=${hmac.digest('hex')}`;
  return {
    'x-slack-signature': signature,
    'x-slack-request-timestamp': timestamp,
    'content-type': 'application/json',
  };
}

async function pollUntil(
  predicate: () => Promise<boolean>,
  intervalMs = 200,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ─── Test state ───────────────────────────────────────────────────────────────

let cpApp: FastifyInstance;
let relayApp: FastifyInstance;
let prisma: PrismaClient;
let tempDbPath: string;

const slackPostMessageCalls: Array<{ channel: string; text?: string; blocks?: unknown[] }> = [];

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // 0. Override DATA_DIR and reset module cache so that controlPlaneConfig
  //    re-evaluates with the isolated DATA_DIR on dynamic import below.
  vi.stubEnv('DATA_DIR', TEST_DATA_DIR);
  vi.resetModules();

  // 1. Create temp SQLite DB
  tempDbPath = `/tmp/test-tc006-${randomUUID()}.db`;
  const dbUrl = `file:${tempDbPath}`;

  await mkdir(TEST_DATA_DIR, { recursive: true });

  execSync('npx prisma db push --skip-generate', {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    cwd: '/home/ubuntu/.openclaw/workspace/claw-orchestrator',
  });

  // 2. Create PrismaClient
  prisma = new PrismaClient({ datasourceUrl: dbUrl });
  await prisma.$connect();

  // 3. Seed default container image
  await prisma.containerImage.create({
    data: {
      id: randomUUID(),
      tag: 'claw-tenant:test',
      is_default: 1,
      created_at: mockNow++,
    },
  });

  // 4. NO allowlist entry for T_BLOCKED / U_BLOCKED — intentionally omitted
  //    This is the key setup for this test: the user is not authorized.

  // 5. Dynamically import buildApp AFTER vi.resetModules()
  const { buildApp } = await import('../../apps/control-plane/src/app-factory.js') as {
    buildApp: typeof BuildAppFn;
  };

  const mockDockerClient = {
    run: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  };

  cpApp = await buildApp(prisma, { logger: false, dockerClient: mockDockerClient });
  await cpApp.listen({ port: CP_PORT, host: '127.0.0.1' });

  // 6. Install fetch interceptor
  const originalFetch = globalThis.fetch;

  const mockedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof URL ? input.toString() : input);

    if (url.includes('slack.com/api/conversations.open')) {
      return new Response(
        JSON.stringify({ ok: true, channel: { id: 'D_TC006_BLOCKED' } }),
        { status: 200 },
      );
    }

    if (url.includes('slack.com/api/chat.postMessage')) {
      const body = JSON.parse(init?.body as string ?? '{}') as {
        channel?: string;
        text?: string;
        blocks?: unknown[];
      };
      slackPostMessageCalls.push({
        channel: body.channel ?? '',
        text: body.text,
        blocks: body.blocks,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (url.includes(`127.0.0.1:${CP_PORT}`) || url.includes(`localhost:${CP_PORT}`)) {
      return originalFetch(input, init);
    }

    return originalFetch(input, init);
  }) as unknown as typeof fetch;

  globalThis.fetch = mockedFetch;

  // 7. Build slack-relay (dynamically imported so it picks up reset modules)
  const { buildSlackRelayApp } = await import('../../apps/slack-relay/src/app-factory.js') as {
    buildSlackRelayApp: typeof BuildRelayFn;
  };

  const relayConfig = {
    SLACK_RELAY_PORT: RELAY_PORT,
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    SLACK_BOT_TOKEN: BOT_TOKEN,
    CONTROL_PLANE_URL: `http://127.0.0.1:${CP_PORT}`,
  };

  relayApp = await buildSlackRelayApp(relayConfig, mockedFetch, prisma);
  await relayApp.listen({ port: RELAY_PORT, host: '127.0.0.1' });
}, 60_000);

afterAll(async () => {
  if (relayApp) await relayApp.close();
  if (cpApp) await cpApp.close();
  if (prisma) await prisma.$disconnect();

  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(tempDbPath);
  } catch { /* best-effort */ }

  // Clean up the entire private data dir (no other test uses /tmp/claw-tc006-isolated)
  try {
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
  } catch { /* best-effort */ }
}, 30_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TC-006: Allowlist enforcement → unauthorized user rejected', () => {
  const eventBody = JSON.stringify({
    type: 'event_callback',
    team_id: TEST_TEAM_ID,
    event_id: 'Ev_TC006_001',
    event: {
      user: TEST_USER_ID,
      type: 'message',
      text: 'Hello, let me in!',
      channel: 'C_TC006',
    },
  });

  it('TC-006: relay returns HTTP 200 immediately (Slack ack)', async () => {
    const res = await relayApp.inject({
      method: 'POST',
      url: '/slack/events',
      headers: makeSlackHeaders(eventBody),
      payload: eventBody,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({});
  }, 10_000);

  it('TC-006: control plane returns 403 for unauthorized user', async () => {
    const res = await cpApp.inject({
      method: 'POST',
      url: '/v1/tenants/provision',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ slackTeamId: TEST_TEAM_ID, slackUserId: TEST_USER_ID }),
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Access denied' });
  }, 10_000);

  it('TC-006: no tenant row created for unauthorized user', async () => {
    // Allow async background processing to settle
    await new Promise((r) => setTimeout(r, 1000));

    const tenants = await prisma.tenant.findMany({
      where: {
        slack_team_id: TEST_TEAM_ID,
        slack_user_id: TEST_USER_ID,
      },
    });

    expect(tenants).toHaveLength(0);
  }, 10_000);

  it('TC-006: Slack chat.postMessage called with invite-only rejection message', async () => {
    const called = await pollUntil(async () => {
      return slackPostMessageCalls.some((c) => c.text?.includes('invite-only'));
    }, 200, 15_000);

    expect(called).toBe(true);
    const call = slackPostMessageCalls.find((c) => c.text?.includes('invite-only'));
    expect(call).toBeDefined();
    expect(call!.text).toContain('invite-only');
  }, 20_000);

  it('TC-006: ACCESS_DENIED audit log entry exists with null tenant_id', async () => {
    const found = await pollUntil(async () => {
      const log = await prisma.auditLog.findFirst({
        where: { event_type: 'ACCESS_DENIED' },
      });
      return log !== null;
    }, 200, 15_000);

    expect(found).toBe(true);

    const log = await prisma.auditLog.findFirst({
      where: { event_type: 'ACCESS_DENIED' },
    });
    expect(log).not.toBeNull();
    expect(log!.tenant_id).toBeNull();

    const metadata = JSON.parse(log!.metadata ?? '{}') as {
      slackTeamId?: string;
      slackUserId?: string;
    };
    expect(metadata.slackTeamId).toBe(TEST_TEAM_ID);
    expect(metadata.slackUserId).toBe(TEST_USER_ID);
  }, 20_000);
});

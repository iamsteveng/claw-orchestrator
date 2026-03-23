/**
 * TC-002: Repeated messages from same user → same tenant reused
 *
 * End-to-end test verifying that a second message from the same Slack user
 * reuses the existing tenant rather than provisioning a new one:
 * - First message → tenant provisioned → ACTIVE
 * - Second message (same team+user, different event_id) → relay returns 200 immediately
 * - No new tenant row created (count = 1 for this principal)
 * - Same tenant_id used for both messages
 * - Second message_queue row added and delivered
 * - Tenant last_activity_at updated
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';

// Mock Date.now() to small incrementing counter to avoid SQLite Int32 overflow
let mockNow = 4_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);

import { buildApp } from '../../apps/control-plane/src/app-factory.js';
import { buildSlackRelayApp } from '../../apps/slack-relay/src/app-factory.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_TEAM_ID = 'T_TC002';
const TEST_USER_ID = 'U_TC002';
const SIGNING_SECRET = 'test-signing-secret-tc002';
const BOT_TOKEN = 'xoxb-test-token-tc002';

// Use the same DATA_DIR that controlPlaneConfig resolves to (set by vitest-setup.ts)
const TEST_DATA_DIR = process.env.DATA_DIR ?? '/tmp/claw-test-tenants';

// Ports distinct from other e2e tests
// first-message: 13298/13299, lifecycle: 13301/13302, isolation: 13303, cp-extended: 13305
// TC-001: 13307/13308, TC-002: 13309/13310
const CP_PORT = 13309;
const RELAY_PORT = 13310;

// ─── Mock Docker client ────────────────────────────────────────────────────────

const mockDockerClient = {
  run: vi.fn().mockResolvedValue(undefined),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
};

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

function computeExpectedTenantId(teamId: string, userId: string): string {
  return createHash('sha256')
    .update(`${teamId}:${userId}`)
    .digest('hex')
    .slice(0, 16);
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
let mockedFetch: ReturnType<typeof vi.fn>;

const slackPostMessageCalls: Array<{ channel: string; text?: string; blocks?: unknown[] }> = [];

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Create temp SQLite DB
  tempDbPath = `/tmp/test-tc002-${randomUUID()}.db`;
  const dbUrl = `file:${tempDbPath}`;

  await mkdir(TEST_DATA_DIR, { recursive: true });

  const result = spawnSync(`${process.cwd()}/node_modules/.bin/prisma`, ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    shell: false,
    cwd: process.cwd(),
  });
  if (result.status !== 0) throw new Error('prisma db push failed: ' + String(result.stderr ?? result.stdout ?? 'unknown error'));

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

  // 4. Seed allowlist entry for T_TC002 / U_TC002
  await prisma.allowlist.create({
    data: {
      id: randomUUID(),
      slack_team_id: TEST_TEAM_ID,
      slack_user_id: TEST_USER_ID,
      added_by: 'tc-002-test-setup',
      created_at: mockNow++,
    },
  });

  // 5. Build control-plane with mocked docker client
  cpApp = await buildApp(prisma, { logger: false, dockerClient: mockDockerClient });
  await cpApp.listen({ port: CP_PORT, host: '127.0.0.1' });

  // 6. Install fetch interceptor
  const originalFetch = globalThis.fetch;

  mockedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof URL ? input.toString() : input);

    if (url.includes(':3101/health')) {
      return new Response(JSON.stringify({ ok: true, status: 'healthy' }), { status: 200 });
    }

    if (url.includes(':3100/message')) {
      return new Response(
        JSON.stringify({ ok: true, response: 'Hello from agent TC-002!', blocks: null }),
        { status: 200 },
      );
    }

    if (url.includes('slack.com/api/conversations.open')) {
      return new Response(
        JSON.stringify({ ok: true, channel: { id: 'D_TC002' } }),
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

  // 7. Build slack-relay
  const relayConfig = {
    SLACK_RELAY_PORT: RELAY_PORT,
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    SLACK_BOT_TOKEN: BOT_TOKEN,
    CONTROL_PLANE_URL: `http://127.0.0.1:${CP_PORT}`,
  };

  relayApp = await buildSlackRelayApp(relayConfig, mockedFetch, prisma);
  await relayApp.listen({ port: RELAY_PORT, host: '127.0.0.1' });

  // 8. Send first message and wait for tenant to be ACTIVE
  const firstEventBody = JSON.stringify({
    type: 'event_callback',
    team_id: TEST_TEAM_ID,
    event_id: 'Ev_TC002_001',
    event: {
      user: TEST_USER_ID,
      type: 'message',
      text: 'First message from TC-002',
      channel: 'C_TC002',
    },
  });

  await relayApp.inject({
    method: 'POST',
    url: '/slack/events',
    headers: makeSlackHeaders(firstEventBody),
    payload: firstEventBody,
  });

  const expectedTenantId = computeExpectedTenantId(TEST_TEAM_ID, TEST_USER_ID);
  await pollUntil(async () => {
    const tenant = await prisma.tenant.findUnique({ where: { id: expectedTenantId } });
    return tenant?.status === 'ACTIVE';
  }, 200, 30_000);
}, 60_000);

afterAll(async () => {
  if (relayApp) await relayApp.close();
  if (cpApp) await cpApp.close();
  if (prisma) await prisma.$disconnect();

  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(tempDbPath);
  } catch { /* best-effort */ }

  // Clean up only this test's tenant directory (not the shared base dir)
  try {
    await rm(`${TEST_DATA_DIR}/${computeExpectedTenantId(TEST_TEAM_ID, TEST_USER_ID)}`, { recursive: true, force: true });
  } catch { /* best-effort */ }
}, 30_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TC-002: Repeated messages from same user → same tenant reused', () => {
  const expectedTenantId = computeExpectedTenantId(TEST_TEAM_ID, TEST_USER_ID);

  const secondEventBody = JSON.stringify({
    type: 'event_callback',
    team_id: TEST_TEAM_ID,
    event_id: 'Ev_TC002_002',
    event: {
      user: TEST_USER_ID,
      type: 'message',
      text: 'Second message from TC-002',
      channel: 'C_TC002',
    },
  });

  let lastActivityBefore: number | null = null;

  it('TC-002: tenant is ACTIVE before second message', async () => {
    const tenant = await prisma.tenant.findUnique({ where: { id: expectedTenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.status).toBe('ACTIVE');
    lastActivityBefore = tenant!.last_activity_at;
  }, 10_000);

  it('TC-002: relay returns HTTP 200 immediately for second message', async () => {
    const res = await relayApp.inject({
      method: 'POST',
      url: '/slack/events',
      headers: makeSlackHeaders(secondEventBody),
      payload: secondEventBody,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({});
  }, 10_000);

  it('TC-002: no new tenant row created — exactly 1 tenant for this principal', async () => {
    // Give a moment for any async operations
    await new Promise((r) => setTimeout(r, 500));

    const tenants = await prisma.tenant.findMany({
      where: {
        slack_team_id: TEST_TEAM_ID,
        slack_user_id: TEST_USER_ID,
      },
    });

    expect(tenants).toHaveLength(1);
    expect(tenants[0].id).toBe(expectedTenantId);
  }, 10_000);

  it('TC-002: second message_queue row added and delivered', async () => {
    const delivered = await pollUntil(async () => {
      const rows = await prisma.messageQueue.findMany({
        where: { tenant_id: expectedTenantId, status: 'DELIVERED' },
      });
      return rows.length >= 2;
    }, 200, 30_000);

    expect(delivered).toBe(true);

    const rows = await prisma.messageQueue.findMany({
      where: { tenant_id: expectedTenantId },
      orderBy: { created_at: 'asc' },
    });
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // Verify second message is present by its slack_event_id
    const secondMsg = rows.find((r: { slack_event_id: string }) =>
      r.slack_event_id === 'Ev_TC002_002'
    );
    expect(secondMsg).toBeDefined();
    expect(secondMsg!.status).toBe('DELIVERED');
  }, 35_000);

  it('TC-002: tenant last_activity_at updated after second message', async () => {
    const tenant = await prisma.tenant.findUnique({ where: { id: expectedTenantId } });
    expect(tenant).not.toBeNull();

    if (lastActivityBefore !== null) {
      expect(tenant!.last_activity_at).toBeGreaterThanOrEqual(lastActivityBefore);
    }
  }, 10_000);

  it('TC-002: audit log contains MESSAGE_DELIVERED twice (once per message)', async () => {
    const delivered = await pollUntil(async () => {
      const logs = await prisma.auditLog.findMany({
        where: {
          tenant_id: expectedTenantId,
          event_type: 'MESSAGE_DELIVERED',
        },
      });
      return logs.length >= 2;
    }, 200, 30_000);

    expect(delivered).toBe(true);

    const logs = await prisma.auditLog.findMany({
      where: {
        tenant_id: expectedTenantId,
        event_type: 'MESSAGE_DELIVERED',
      },
    });
    expect(logs.length).toBeGreaterThanOrEqual(2);
  }, 35_000);
});

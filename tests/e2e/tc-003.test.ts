/**
 * TC-003: Stopped tenant → wakes on next message → queued messages replayed
 *
 * End-to-end test verifying that a stopped tenant wakes on the next Slack message:
 * - Provision a tenant and bring to ACTIVE (via initial relay message)
 * - Stop the tenant via POST /v1/tenants/:id/stop
 * - Assert tenant status = STOPPED
 * - Send a Slack event to the relay for this tenant
 * - Assert relay calls /v1/tenants/:id/start
 * - Mock health endpoint returns healthy after start
 * - Poll until tenant status = ACTIVE
 * - Assert queued message_queue rows are delivered in FIFO order
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';

// Mock Date.now() to small incrementing counter to avoid SQLite Int32 overflow
let mockNow = 5_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);

import { buildApp } from '../../apps/control-plane/src/app-factory.js';
import { buildSlackRelayApp } from '../../apps/slack-relay/src/app-factory.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_TEAM_ID = 'T_TC003_SOLO';
const TEST_USER_ID = 'U_TC003_SOLO';
const SIGNING_SECRET = 'test-signing-secret-tc003';
const BOT_TOKEN = 'xoxb-test-token-tc003';

// Use the same DATA_DIR that controlPlaneConfig resolves to (set by vitest-setup.ts)
const TEST_DATA_DIR = process.env.DATA_DIR ?? '/tmp/claw-test-tenants';

// Ports distinct from other e2e tests:
// first-message: 13298/13299, lifecycle: 13301/13302, isolation: 13303/13304,
// cp-extended: 13305/13306, TC-001: 13307/13308, TC-002: 13309/13310
const CP_PORT = 13311;
const RELAY_PORT = 13312;

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

const slackPostMessageCalls: Array<{ channel: string; text?: string }> = [];
const startCallUrls: string[] = [];

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Create temp SQLite DB
  tempDbPath = `/tmp/test-tc003-${randomUUID()}.db`;
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

  // 4. Seed allowlist entry
  await prisma.allowlist.create({
    data: {
      id: randomUUID(),
      slack_team_id: TEST_TEAM_ID,
      slack_user_id: TEST_USER_ID,
      added_by: 'tc-003-test-setup',
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

    // Track /start calls made by the relay
    if (url.includes('/v1/tenants/') && url.endsWith('/start')) {
      startCallUrls.push(url);
    }

    if (url.includes(':3101/health')) {
      return new Response(JSON.stringify({ ok: true, status: 'healthy' }), { status: 200 });
    }

    if (url.includes(':3100/message')) {
      return new Response(
        JSON.stringify({ ok: true, response: 'Hello from agent TC-003!', blocks: null }),
        { status: 200 },
      );
    }

    if (url.includes('slack.com/api/conversations.open')) {
      return new Response(
        JSON.stringify({ ok: true, channel: { id: 'D_TC003' } }),
        { status: 200 },
      );
    }

    if (url.includes('slack.com/api/chat.postMessage')) {
      const body = JSON.parse(init?.body as string ?? '{}') as {
        channel?: string;
        text?: string;
      };
      slackPostMessageCalls.push({ channel: body.channel ?? '', text: body.text });
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

  // 8. Send initial message to provision tenant and bring to ACTIVE
  const initEventBody = JSON.stringify({
    type: 'event_callback',
    team_id: TEST_TEAM_ID,
    event_id: 'Ev_TC003_INIT',
    event: {
      user: TEST_USER_ID,
      type: 'message',
      text: 'Initial message — provision and start tenant',
      channel: 'C_TC003',
    },
  });

  await relayApp.inject({
    method: 'POST',
    url: '/slack/events',
    headers: makeSlackHeaders(initEventBody),
    payload: initEventBody,
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
    await rm(`${TEST_DATA_DIR}/${computeExpectedTenantId(TEST_TEAM_ID, TEST_USER_ID)}`, {
      recursive: true,
      force: true,
    });
  } catch { /* best-effort */ }
}, 30_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TC-003: Stopped tenant → wakes on next message → queued messages replayed', () => {
  const tenantId = computeExpectedTenantId(TEST_TEAM_ID, TEST_USER_ID);

  it('TC-003: tenant is ACTIVE after initial provisioning', async () => {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.status).toBe('ACTIVE');
  }, 10_000);

  it('TC-003: stop tenant via POST /v1/tenants/:id/stop → status becomes STOPPED', async () => {
    const stopRes = await cpApp.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/stop`,
      payload: {},
    });
    expect(stopRes.statusCode).toBe(200);

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant?.status).toBe('STOPPED');
  }, 10_000);

  it('TC-003: relay returns HTTP 200 immediately when sending message to stopped tenant', async () => {
    // Reset docker call counters and start-call tracking for this wake-up
    mockDockerClient.start.mockClear();
    mockDockerClient.run.mockClear();
    startCallUrls.length = 0;

    const eventBody = JSON.stringify({
      type: 'event_callback',
      team_id: TEST_TEAM_ID,
      event_id: 'Ev_TC003_MSG1',
      event: {
        user: TEST_USER_ID,
        type: 'message',
        text: 'First message after stop — should wake tenant',
        channel: 'C_TC003',
      },
    });

    const res = await relayApp.inject({
      method: 'POST',
      url: '/slack/events',
      headers: makeSlackHeaders(eventBody),
      payload: eventBody,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({});
  }, 10_000);

  it('TC-003: relay calls /v1/tenants/:id/start on the stopped tenant', async () => {
    // Wait for the relay's async background processing to call /start
    const startCalled = await pollUntil(async () => {
      return startCallUrls.some((url) => url.includes(tenantId));
    }, 200, 10_000);

    expect(startCalled).toBe(true);
  }, 15_000);

  it('TC-003: tenant wakes up and becomes ACTIVE', async () => {
    const active = await pollUntil(async () => {
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
      return tenant?.status === 'ACTIVE';
    }, 200, 30_000);

    expect(active).toBe(true);

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant?.status).toBe('ACTIVE');
  }, 35_000);

  it('TC-003: first queued message is DELIVERED after wake-up', async () => {
    const delivered = await pollUntil(async () => {
      const row = await prisma.messageQueue.findFirst({
        where: { tenant_id: tenantId, slack_event_id: 'Ev_TC003_MSG1', status: 'DELIVERED' },
      });
      return row !== null;
    }, 200, 30_000);

    expect(delivered).toBe(true);
  }, 35_000);

  it('TC-003: subsequent message delivered; message_queue rows are in FIFO order', async () => {
    // Send a second message now that the tenant is ACTIVE
    const secondEventBody = JSON.stringify({
      type: 'event_callback',
      team_id: TEST_TEAM_ID,
      event_id: 'Ev_TC003_MSG2',
      event: {
        user: TEST_USER_ID,
        type: 'message',
        text: 'Second message after wake-up',
        channel: 'C_TC003',
      },
    });

    const res = await relayApp.inject({
      method: 'POST',
      url: '/slack/events',
      headers: makeSlackHeaders(secondEventBody),
      payload: secondEventBody,
    });
    expect(res.statusCode).toBe(200);

    // Wait for second message to be DELIVERED
    const delivered = await pollUntil(async () => {
      const row = await prisma.messageQueue.findFirst({
        where: { tenant_id: tenantId, slack_event_id: 'Ev_TC003_MSG2', status: 'DELIVERED' },
      });
      return row !== null;
    }, 200, 30_000);

    expect(delivered).toBe(true);

    // Fetch all delivered rows for this tenant in FIFO order
    const allRows = await prisma.messageQueue.findMany({
      where: { tenant_id: tenantId, status: 'DELIVERED' },
      orderBy: { created_at: 'asc' },
    });

    expect(allRows.length).toBeGreaterThanOrEqual(2);

    // Verify monotonically non-decreasing created_at (FIFO order)
    for (let i = 1; i < allRows.length; i++) {
      expect(allRows[i].created_at).toBeGreaterThanOrEqual(allRows[i - 1].created_at);
    }

    // MSG1 must appear before MSG2 in the queue
    const msg1Row = allRows.find((r: { slack_event_id: string }) => r.slack_event_id === 'Ev_TC003_MSG1');
    const msg2Row = allRows.find((r: { slack_event_id: string }) => r.slack_event_id === 'Ev_TC003_MSG2');
    expect(msg1Row).toBeDefined();
    expect(msg2Row).toBeDefined();
    expect(msg1Row!.created_at).toBeLessThan(msg2Row!.created_at);
  }, 40_000);
});

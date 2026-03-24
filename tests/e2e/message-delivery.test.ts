/**
 * E2E: Full message delivery chain
 *
 * Tests the full Slack → relay → CP → container (mocked) → Slack response chain:
 * 1. Provisions a tenant via the relay (sending a Slack event)
 * 2. Waits for tenant to be ACTIVE
 * 3. Verifies chat.postMessage is called with 'Hello from agent'
 * 4. Verifies message_queue row ends up as DELIVERED
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';

// Mock Date.now() to small incrementing counter to avoid SQLite Int32 overflow
let mockNow = 40_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);

import { buildApp } from '../../apps/control-plane/src/app-factory.js';
import { buildSlackRelayApp } from '../../apps/slack-relay/src/app-factory.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_TEAM_ID = 'T_MSG_DEL';
const TEST_USER_ID = 'U_MSG_DEL';
const SIGNING_SECRET = 'test-signing-secret-msg-delivery';
const BOT_TOKEN = 'xoxb-test-msg-delivery';
const AGENT_RESPONSE = 'Hello from agent';

const TEST_DATA_DIR = process.env.DATA_DIR ?? '/tmp/claw-test-tenants';

// Ports distinct from all other e2e tests
const CP_PORT = 13319;
const RELAY_PORT = 13320;

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
  tempDbPath = `/tmp/test-msg-delivery-${randomUUID()}.db`;
  const dbUrl = `file:${tempDbPath}`;

  await mkdir(TEST_DATA_DIR, { recursive: true });

  const result = spawnSync(`${process.cwd()}/node_modules/.bin/prisma`, ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    shell: false,
    cwd: process.cwd(),
  });
  if (result.status !== 0) {
    throw new Error('prisma db push failed: ' + String(result.stderr ?? result.stdout ?? 'unknown error'));
  }

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
      added_by: 'message-delivery-test-setup',
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

    // Mock container health check
    if (url.includes(':3101/health')) {
      return new Response(JSON.stringify({ ok: true, status: 'healthy' }), { status: 200 });
    }

    // Mock container message endpoint — returns the agent response
    if (url.includes(':3100/message')) {
      return new Response(
        JSON.stringify({ ok: true, response: AGENT_RESPONSE, blocks: null }),
        { status: 200 },
      );
    }

    // Slack conversations.open
    if (url.includes('slack.com/api/conversations.open')) {
      return new Response(
        JSON.stringify({ ok: true, channel: { id: 'D_MSG_DEL' } }),
        { status: 200 },
      );
    }

    // Slack chat.postMessage — capture calls
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

    // Forward CP calls to the real in-process server
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

  // 8. Send the test message
  const eventBody = JSON.stringify({
    type: 'event_callback',
    team_id: TEST_TEAM_ID,
    event_id: 'Ev_MSG_DEL_001',
    event: {
      user: TEST_USER_ID,
      type: 'message',
      text: 'Hello agent, please respond!',
      channel: 'C_MSG_DEL',
    },
  });

  await relayApp.inject({
    method: 'POST',
    url: '/slack/events',
    headers: makeSlackHeaders(eventBody),
    payload: eventBody,
  });

  // Wait for tenant to become ACTIVE
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

  // Clean up only this test's tenant directory
  try {
    await rm(`${TEST_DATA_DIR}/${computeExpectedTenantId(TEST_TEAM_ID, TEST_USER_ID)}`, {
      recursive: true,
      force: true,
    });
  } catch { /* best-effort */ }
}, 30_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('E2E: Full message delivery chain (relay → CP → container → Slack)', () => {
  const expectedTenantId = computeExpectedTenantId(TEST_TEAM_ID, TEST_USER_ID);

  it('tenant is provisioned and ACTIVE', async () => {
    const tenant = await prisma.tenant.findUnique({ where: { id: expectedTenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.status).toBe('ACTIVE');
  }, 10_000);

  it('chat.postMessage was called with the agent response text', async () => {
    // Wait for the Slack DM to be sent
    const sent = await pollUntil(async () => {
      return slackPostMessageCalls.some((c) => c.text === AGENT_RESPONSE);
    }, 100, 15_000);

    expect(sent).toBe(true);
    const call = slackPostMessageCalls.find((c) => c.text === AGENT_RESPONSE);
    expect(call).toBeDefined();
    expect(call!.text).toBe(AGENT_RESPONSE);
  }, 20_000);

  it('message_queue row ends up as DELIVERED', async () => {
    const delivered = await pollUntil(async () => {
      const rows = await prisma.messageQueue.findMany({
        where: { tenant_id: expectedTenantId, status: 'DELIVERED' },
      });
      return rows.length >= 1;
    }, 200, 15_000);

    expect(delivered).toBe(true);

    const rows = await prisma.messageQueue.findMany({
      where: { tenant_id: expectedTenantId },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].status).toBe('DELIVERED');
  }, 20_000);

  it('audit log contains MESSAGE_DELIVERED event', async () => {
    const found = await pollUntil(async () => {
      const logs = await prisma.auditLog.findMany({
        where: { tenant_id: expectedTenantId, event_type: 'MESSAGE_DELIVERED' },
      });
      return logs.length >= 1;
    }, 200, 15_000);

    expect(found).toBe(true);
  }, 20_000);
});

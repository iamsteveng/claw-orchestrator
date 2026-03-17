/**
 * US-040: End-to-end integration test for the first message flow.
 *
 * Starts real Fastify instances for control-plane and slack-relay,
 * wires them together with mocked Docker client (via dependency injection)
 * and selective fetch interception, then verifies the complete
 * provisioning + message delivery flow.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { mkdir, rm, readFile, access } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';

// Prisma's SQLite driver validates Int columns as 32-bit integers.
// The app uses Date.now() (ms epoch ~13 digits) which exceeds 32-bit range.
// We mock Date.now() to return a small incrementing counter so writes succeed.
let mockNow = 2_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);

// Import app factories
import { buildApp } from '../../apps/control-plane/src/app-factory.js';
import { buildSlackRelayApp } from '../../apps/slack-relay/src/app-factory.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_TEAM_ID = 'T_E2E_TEST';
const TEST_USER_ID = 'U_E2E_TEST';
const SIGNING_SECRET = 'test-signing-secret';
const BOT_TOKEN = 'xoxb-test-token';

// Use the DATA_DIR from vitest-setup — this is what controlPlaneConfig.DATA_DIR resolves to
// at module load time (before any test code runs).
const TEST_DATA_DIR = process.env.DATA_DIR ?? '/tmp/claw-test-tenants';

// Ports well outside the default range to avoid conflicts with other tests
const CP_PORT = 13299;
const RELAY_PORT = 13298;

// ─── Mock docker client (via dependency injection, bypasses ESM dynamic import issues) ─

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

/** Compute deterministic tenantId the same way the control-plane does. */
function computeExpectedTenantId(teamId: string, userId: string): string {
  return createHash('sha256')
    .update(`${teamId}:${userId}`)
    .digest('hex')
    .slice(0, 16);
}

/** Poll with retries until predicate returns true or timeout. */
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ─── Test state ───────────────────────────────────────────────────────────────

let cpApp: FastifyInstance;
let relayApp: FastifyInstance;
let prisma: PrismaClient;
let tempDbPath: string;

// Track fetch calls to Slack API
const slackPostMessageCalls: Array<{ channel: string; text?: string; blocks?: unknown[] }> = [];

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Create temp SQLite DB and run prisma db push
  tempDbPath = `/tmp/test-e2e-${randomUUID()}.db`;
  const dbUrl = `file:${tempDbPath}`;

  // Ensure test data dir exists
  await mkdir(TEST_DATA_DIR, { recursive: true });

  execSync('npx prisma db push --skip-generate', {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    cwd: '/home/ubuntu/.openclaw/workspace/claw-orchestrator',
  });

  // 2. Create PrismaClient with temp DB
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

  // 4. Seed allowlist entry for the specific test user
  await prisma.allowlist.create({
    data: {
      id: randomUUID(),
      slack_team_id: TEST_TEAM_ID,
      slack_user_id: TEST_USER_ID,
      added_by: 'e2e-test-setup',
      created_at: mockNow++,
    },
  });

  // 5. Build control-plane app with injected mock docker client, listen on CP_PORT
  cpApp = await buildApp(prisma, { logger: false, dockerClient: mockDockerClient });
  await cpApp.listen({ port: CP_PORT, host: '127.0.0.1' });

  // 6. Install selective fetch interceptor AFTER control-plane is listening.
  const originalFetch = globalThis.fetch;

  const mockedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof URL ? input.toString() : input);

    // Container health endpoint (port 3101) → return healthy immediately
    if (url.includes(':3101/health')) {
      return new Response(JSON.stringify({ ok: true, status: 'healthy' }), { status: 200 });
    }

    // Container message endpoint (port 3100) → return agent response
    if (url.includes(':3100/message')) {
      return new Response(
        JSON.stringify({ ok: true, response: 'Hello from agent!', blocks: null }),
        { status: 200 },
      );
    }

    // Slack conversations.open → return success with DM channel
    if (url.includes('slack.com/api/conversations.open')) {
      return new Response(
        JSON.stringify({ ok: true, channel: { id: 'D_E2E_TEST' } }),
        { status: 200 },
      );
    }

    // Slack chat.postMessage → record call and return success
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

    // Control-plane requests (localhost:CP_PORT) → pass through to real server
    if (url.includes(`127.0.0.1:${CP_PORT}`) || url.includes(`localhost:${CP_PORT}`)) {
      return originalFetch(input, init);
    }

    // Default: pass through
    return originalFetch(input, init);
  }) as unknown as typeof fetch;

  globalThis.fetch = mockedFetch;

  // 7. Build slack-relay app with config pointing to the test control-plane
  //    Pass prisma so the relay can manage message_queue rows
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

  // Cleanup temp DB
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(tempDbPath);
  } catch { /* best-effort */ }

  // Cleanup test tenant data directory
  const expectedTenantId = computeExpectedTenantId(TEST_TEAM_ID, TEST_USER_ID);
  try {
    await rm(`${TEST_DATA_DIR}/${expectedTenantId}`, { recursive: true, force: true });
  } catch { /* best-effort */ }
}, 30_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('E2E: First Slack message — provisions tenant and delivers response', () => {
  const expectedTenantId = computeExpectedTenantId(TEST_TEAM_ID, TEST_USER_ID);

  it('relay returns HTTP 200 immediately', async () => {
    const eventBody = JSON.stringify({
      type: 'event_callback',
      team_id: TEST_TEAM_ID,
      event_id: 'Ev_E2E_001',
      event: {
        user: TEST_USER_ID,
        type: 'message',
        text: 'Hello world',
        channel: 'C_E2E_TEST',
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

  it('tenant row transitions through PROVISIONING → STARTING → ACTIVE', async () => {
    // Poll until tenant is ACTIVE (provisioning + start + health poll all complete)
    // Health poll runs every 2s; relay status poll runs every 2s
    const becameActive = await pollUntil(async () => {
      const tenant = await prisma.tenant.findUnique({ where: { id: expectedTenantId } });
      return tenant?.status === 'ACTIVE';
    }, 200, 30_000);

    expect(becameActive).toBe(true);

    // Verify the tenant exists with correct attributes
    const tenant = await prisma.tenant.findUnique({ where: { id: expectedTenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.slack_team_id).toBe(TEST_TEAM_ID);
    expect(tenant!.slack_user_id).toBe(TEST_USER_ID);
    expect(tenant!.status).toBe('ACTIVE');
  }, 35_000);

  it('tenant directories were created at DATA_DIR/<tenantId>/home, /workspace, /config, /logs, /secrets', async () => {
    const base = `${TEST_DATA_DIR}/${expectedTenantId}`;
    for (const subdir of ['home', 'workspace', 'config', 'logs', 'secrets']) {
      const dirExists = await fileExists(`${base}/${subdir}`);
      expect(dirExists, `Expected ${base}/${subdir} to exist`).toBe(true);
    }
  }, 10_000);

  it('AGENTS.md was seeded in the tenant workspace containing "## Task Execution"', async () => {
    const agentsMdPath = `${TEST_DATA_DIR}/${expectedTenantId}/workspace/AGENTS.md`;
    const exists = await fileExists(agentsMdPath);
    expect(exists).toBe(true);

    const content = await readFile(agentsMdPath, 'utf8');
    expect(content).toContain('## Task Execution');
  }, 10_000);

  it('message_queue row was created with status=DELIVERED after processing', async () => {
    const delivered = await pollUntil(async () => {
      const row = await prisma.messageQueue.findFirst({
        where: { tenant_id: expectedTenantId, status: 'DELIVERED' },
      });
      return row !== null;
    }, 200, 30_000);

    expect(delivered).toBe(true);
  }, 35_000);

  it('Slack chat.postMessage was called with the tenant response', async () => {
    // Wait for postMessage to have been recorded
    const called = await pollUntil(async () => {
      return slackPostMessageCalls.some(
        (c) => c.text === 'Hello from agent!',
      );
    }, 200, 30_000);

    expect(called).toBe(true);
    const call = slackPostMessageCalls.find((c) => c.text === 'Hello from agent!');
    expect(call).toBeDefined();
  }, 35_000);

  it('audit log contains TENANT_PROVISIONED, TENANT_STARTED, MESSAGE_DELIVERED events in order', async () => {
    // Wait until all three events are present
    const allPresent = await pollUntil(async () => {
      const logs = await prisma.auditLog.findMany({
        where: {
          tenant_id: expectedTenantId,
          event_type: { in: ['TENANT_PROVISIONED', 'TENANT_STARTED', 'MESSAGE_DELIVERED'] },
        },
        orderBy: { created_at: 'asc' },
      });
      const types = logs.map((l: { event_type: string }) => l.event_type);
      return (
        types.includes('TENANT_PROVISIONED') &&
        types.includes('TENANT_STARTED') &&
        types.includes('MESSAGE_DELIVERED')
      );
    }, 200, 30_000);

    expect(allPresent).toBe(true);

    const logs = await prisma.auditLog.findMany({
      where: {
        tenant_id: expectedTenantId,
        event_type: { in: ['TENANT_PROVISIONED', 'TENANT_STARTED', 'MESSAGE_DELIVERED'] },
      },
      orderBy: { created_at: 'asc' },
    });

    const types = logs.map((l: { event_type: string }) => l.event_type);
    const provIdx = types.indexOf('TENANT_PROVISIONED');
    const startIdx = types.indexOf('TENANT_STARTED');
    const delivIdx = types.indexOf('MESSAGE_DELIVERED');

    expect(provIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(delivIdx).toBeGreaterThanOrEqual(0);
    expect(provIdx).toBeLessThan(startIdx);
    expect(startIdx).toBeLessThan(delivIdx);
  }, 35_000);
});

describe('E2E: Second message from same user reuses same tenant', () => {
  const expectedTenantId = computeExpectedTenantId(TEST_TEAM_ID, TEST_USER_ID);

  it('second message reuses the same tenant_id (no new provisioning)', async () => {
    // Wait until first message flow completes: tenant should be ACTIVE
    const isActive = await pollUntil(async () => {
      const tenant = await prisma.tenant.findUnique({ where: { id: expectedTenantId } });
      return tenant?.status === 'ACTIVE';
    }, 200, 30_000);
    expect(isActive).toBe(true);

    const tenantCountBefore = await prisma.tenant.count({
      where: { principal: `${TEST_TEAM_ID}:${TEST_USER_ID}` },
    });

    const eventBody = JSON.stringify({
      type: 'event_callback',
      team_id: TEST_TEAM_ID,
      event_id: 'Ev_E2E_002',
      event: {
        user: TEST_USER_ID,
        type: 'message',
        text: 'Second message',
        channel: 'C_E2E_TEST',
      },
    });

    const res = await relayApp.inject({
      method: 'POST',
      url: '/slack/events',
      headers: makeSlackHeaders(eventBody),
      payload: eventBody,
    });

    expect(res.statusCode).toBe(200);

    // Wait for second message to be delivered
    const secondDelivered = await pollUntil(async () => {
      const rows = await prisma.messageQueue.findMany({
        where: { tenant_id: expectedTenantId, status: 'DELIVERED' },
      });
      return rows.length >= 2;
    }, 200, 30_000);

    expect(secondDelivered).toBe(true);

    // Only one tenant row should exist for this principal
    const tenantCountAfter = await prisma.tenant.count({
      where: { principal: `${TEST_TEAM_ID}:${TEST_USER_ID}` },
    });
    expect(tenantCountAfter).toBe(tenantCountBefore);
    expect(tenantCountAfter).toBe(1);

    // The tenant still has the same id
    const tenantAfter = await prisma.tenant.findUnique({ where: { id: expectedTenantId } });
    expect(tenantAfter).not.toBeNull();
    expect(tenantAfter!.id).toBe(expectedTenantId);
  }, 60_000);
});

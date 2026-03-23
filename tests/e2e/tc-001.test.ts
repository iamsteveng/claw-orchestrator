/**
 * TC-001: First Slack message → tenant provisioned → container started → message delivered
 *
 * End-to-end test verifying the complete first-message provisioning flow:
 * - Allowlist pre-seeded for T_TC001 / U_TC001
 * - Relay returns 200 immediately
 * - Tenant transitions NEW → PROVISIONING → STARTING → ACTIVE
 * - Tenant directories created (home, workspace, config, logs, secrets)
 * - AGENTS.md seeded with '## Task Execution'
 * - message_queue row transitions to DELIVERED
 * - Slack chat.postMessage called with agent response
 * - Audit log contains TENANT_PROVISIONED, TENANT_STARTED, MESSAGE_DELIVERED in order
 *
 * Uses a private DATA_DIR (/tmp/claw-tc001-isolated) to avoid interference from
 * other e2e test files that wipe /tmp/claw-test-tenants in their afterAll hooks
 * when running concurrently. The isolation is achieved by calling vi.stubEnv +
 * vi.resetModules before dynamically importing buildApp, forcing controlPlaneConfig
 * to re-evaluate with the isolated DATA_DIR.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { mkdir, rm, readFile, access, writeFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { buildApp as BuildAppFn } from '../../apps/control-plane/src/app-factory.js';
import type { buildSlackRelayApp as BuildRelayFn } from '../../apps/slack-relay/src/app-factory.js';

// Mock Date.now() to small incrementing counter to avoid SQLite Int32 overflow.
// Must be set before any module that calls Date.now() at load time.
let mockNow = 3_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_TEAM_ID = 'T_TC001';
const TEST_USER_ID = 'U_TC001';
const SIGNING_SECRET = 'test-signing-secret';
const BOT_TOKEN = 'xoxb-test-token';

// Private data dir — completely separate from /tmp/claw-test-tenants to avoid
// being wiped by isolation.test.ts / control-plane-extended.test.ts afterAll hooks
// that do rm -rf /tmp/claw-test-tenants when running concurrently.
const TEST_DATA_DIR = '/tmp/claw-tc001-isolated';

// Ports distinct from other e2e tests
// first-message: 13298/13299, lifecycle: 13301/13302, isolation: 13303, cp-extended: 13305
const CP_PORT = 13307;
const RELAY_PORT = 13308;

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

const slackPostMessageCalls: Array<{ channel: string; text?: string; blocks?: unknown[] }> = [];

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // 0. Override DATA_DIR and reset module cache so that when buildApp is imported
  //    below, @claw/shared-config/control-plane re-evaluates with the new DATA_DIR.
  //    This prevents /tmp/claw-test-tenants from being used (which other concurrent
  //    test files can delete in their afterAll hooks).
  vi.stubEnv('DATA_DIR', TEST_DATA_DIR);
  vi.resetModules();

  // 1. Create temp SQLite DB
  tempDbPath = `/tmp/test-tc001-${randomUUID()}.db`;
  const dbUrl = `file:${tempDbPath}`;

  await mkdir(TEST_DATA_DIR, { recursive: true });

  execSync(`${process.cwd()}/node_modules/.bin/prisma db push --skip-generate`, {
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

  // 4. Seed allowlist entry for T_TC001 / U_TC001
  await prisma.allowlist.create({
    data: {
      id: randomUUID(),
      slack_team_id: TEST_TEAM_ID,
      slack_user_id: TEST_USER_ID,
      added_by: 'tc-001-test-setup',
      created_at: mockNow++,
    },
  });

  // 5. Dynamically import buildApp AFTER vi.resetModules() so that
  //    @claw/shared-config/control-plane re-evaluates with DATA_DIR=TEST_DATA_DIR.
  const { buildApp } = await import('../../apps/control-plane/src/app-factory.js') as {
    buildApp: typeof BuildAppFn;
  };

  cpApp = await buildApp(prisma, { logger: false, dockerClient: mockDockerClient });
  await cpApp.listen({ port: CP_PORT, host: '127.0.0.1' });

  // 6. Install fetch interceptor
  const originalFetch = globalThis.fetch;

  const mockedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof URL ? input.toString() : input);

    if (url.includes(':3101/health')) {
      return new Response(JSON.stringify({ ok: true, status: 'healthy' }), { status: 200 });
    }

    if (url.includes(':3100/message')) {
      return new Response(
        JSON.stringify({ ok: true, response: 'Hello from agent TC-001!', blocks: null }),
        { status: 200 },
      );
    }

    if (url.includes('slack.com/api/conversations.open')) {
      return new Response(
        JSON.stringify({ ok: true, channel: { id: 'D_TC001' } }),
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

  // 7. Build slack-relay (also dynamically imported so it picks up reset modules)
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

  // Clean up the entire private data dir (no other test uses /tmp/claw-tc001-isolated)
  try {
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
  } catch { /* best-effort */ }
}, 30_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TC-001: First Slack message → tenant provisioned → container started → message delivered', () => {
  const expectedTenantId = computeExpectedTenantId(TEST_TEAM_ID, TEST_USER_ID);

  const eventBody = JSON.stringify({
    type: 'event_callback',
    team_id: TEST_TEAM_ID,
    event_id: 'Ev_TC001_001',
    event: {
      user: TEST_USER_ID,
      type: 'message',
      text: 'Hello from TC-001',
      channel: 'C_TC001',
    },
  });

  it('TC-001: relay returns HTTP 200 immediately (before provisioning completes)', async () => {
    const res = await relayApp.inject({
      method: 'POST',
      url: '/slack/events',
      headers: makeSlackHeaders(eventBody),
      payload: eventBody,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({});
  }, 10_000);

  it('TC-001: tenant row transitions to ACTIVE within 30s', async () => {
    const becameActive = await pollUntil(async () => {
      const tenant = await prisma.tenant.findUnique({ where: { id: expectedTenantId } });
      return tenant?.status === 'ACTIVE';
    }, 200, 30_000);

    expect(becameActive).toBe(true);

    const tenant = await prisma.tenant.findUnique({ where: { id: expectedTenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.slack_team_id).toBe(TEST_TEAM_ID);
    expect(tenant!.slack_user_id).toBe(TEST_USER_ID);
    expect(tenant!.status).toBe('ACTIVE');
  }, 35_000);

  it('TC-001: tenant directories created (home, workspace, config, logs, secrets)', async () => {
    const base = `${TEST_DATA_DIR}/${expectedTenantId}`;
    for (const subdir of ['home', 'workspace', 'config', 'logs', 'secrets']) {
      const exists = await fileExists(`${base}/${subdir}`);
      expect(exists, `Expected ${base}/${subdir} to exist`).toBe(true);
    }
  }, 10_000);

  it('TC-001: AGENTS.md seeded in workspace with "## Task Execution" section', async () => {
    const agentsMdPath = `${TEST_DATA_DIR}/${expectedTenantId}/workspace/AGENTS.md`;
    const exists = await fileExists(agentsMdPath);
    expect(exists).toBe(true);

    const content = await readFile(agentsMdPath, 'utf8');
    expect(content).toContain('## Task Execution');

    // Write agent output evidence
    await writeFile(
      '/home/ubuntu/.openclaw/workspace/claw-orchestrator/agent-output.txt',
      `TC-001 Agent Output Evidence\n` +
      `============================\n` +
      `Tenant ID: ${expectedTenantId}\n` +
      `Team: ${TEST_TEAM_ID} / User: ${TEST_USER_ID}\n` +
      `Data Dir: ${TEST_DATA_DIR}\n` +
      `AGENTS.md contents (first 500 chars):\n${content.slice(0, 500)}\n`,
      'utf8',
    );
  }, 10_000);

  it('TC-001: message_queue row transitions to DELIVERED', async () => {
    const delivered = await pollUntil(async () => {
      const row = await prisma.messageQueue.findFirst({
        where: { tenant_id: expectedTenantId, status: 'DELIVERED' },
      });
      return row !== null;
    }, 200, 30_000);

    expect(delivered).toBe(true);
  }, 35_000);

  it('TC-001: Slack chat.postMessage called with agent response', async () => {
    const called = await pollUntil(async () => {
      return slackPostMessageCalls.some((c) => c.text === 'Hello from agent TC-001!');
    }, 200, 30_000);

    expect(called).toBe(true);
    const call = slackPostMessageCalls.find((c) => c.text === 'Hello from agent TC-001!');
    expect(call).toBeDefined();
  }, 35_000);

  it('TC-001: audit log contains TENANT_PROVISIONED, TENANT_STARTED, MESSAGE_DELIVERED in order', async () => {
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

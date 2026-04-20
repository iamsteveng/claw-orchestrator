/**
 * E2E: Full chain with real message-server.js + mock openclaw binary
 *
 * Verifies the complete message path end-to-end:
 *   Slack user → relay → CP → real message-server.js → mock openclaw → relay → Slack DM
 *
 * Unlike first-message.test.ts, the :3100/message endpoint is NOT mocked inline.
 * Instead a real message-server.js process is spawned (port-patched) with a mock
 * openclaw binary that writes JSON to stderr. The fetch interceptor routes the CP's
 * container fetch calls to this local server, exercising the full message-server
 * parsing pipeline end-to-end.
 *
 * Key trick: we pre-provision the tenant before building the relay so we can read
 * the relay_token from the DB and spawn message-server with that exact token.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { writeFileSync, mkdirSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import http from 'node:http';
import type { FastifyInstance } from 'fastify';

// Small incrementing counter avoids SQLite Int32 overflow for timestamp columns
let mockNow = 50_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);

import { buildApp } from '../../apps/control-plane/src/app-factory.js';
import { buildSlackRelayApp } from '../../apps/slack-relay/src/app-factory.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_TEAM_ID = 'T_FULL_CHAIN';
const TEST_USER_ID = 'U_FULL_CHAIN';
const SIGNING_SECRET = 'test-signing-secret-full-chain';
const BOT_TOKEN = 'xoxb-test-full-chain';
const AGENT_RESPONSE = 'Hello from real agent';

const TEST_DATA_DIR = process.env.DATA_DIR ?? '/tmp/claw-test-tenants';

// Ports not used by any other test file
const CP_PORT = 13325;
const RELAY_PORT = 13326;
const MS_PORT = 13327;

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
  return createHash('sha256').update(`${teamId}:${userId}`).digest('hex').slice(0, 16);
}

/** Wait for message-server by sending a POST — any HTTP response means it's up. */
async function waitForMsgServer(port: number, retries = 50, delayMs = 100): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/message',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': 2 },
          },
          (res) => {
            res.resume();
            resolve();
          },
        );
        req.on('error', reject);
        req.write('{}');
        req.end();
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`message-server on port ${port} did not start within ${retries * delayMs}ms`);
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
let msProcess: ChildProcess | null = null;
let msTmpDir: string | null = null;

const slackPostMessageCalls: Array<{ channel: string; text?: string; blocks?: unknown[] }> = [];

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Create isolated temp SQLite DB
  tempDbPath = `/tmp/test-full-chain-${randomUUID()}.db`;
  const dbUrl = `file:${tempDbPath}`;
  await mkdir(TEST_DATA_DIR, { recursive: true });

  const result = spawnSync(
    `${process.cwd()}/node_modules/.bin/prisma`,
    ['db', 'push', '--skip-generate'],
    {
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: 'pipe',
      shell: false,
      cwd: process.cwd(),
    },
  );
  if (result.status !== 0) {
    throw new Error('prisma db push failed: ' + String(result.stderr ?? result.stdout ?? 'unknown'));
  }

  // 2. PrismaClient
  prisma = new PrismaClient({ datasourceUrl: dbUrl });
  await prisma.$connect();

  // 3. Seed default container image + allowlist entry
  await prisma.containerImage.create({
    data: { id: randomUUID(), tag: 'claw-tenant:test', is_default: 1, created_at: mockNow++ },
  });
  await prisma.allowlist.create({
    data: {
      id: randomUUID(),
      slack_team_id: TEST_TEAM_ID,
      slack_user_id: TEST_USER_ID,
      added_by: 'full-chain-test',
      created_at: mockNow++,
    },
  });

  // 4. Build control-plane with mocked docker client
  cpApp = await buildApp(prisma, { logger: false, dockerClient: mockDockerClient });
  await cpApp.listen({ port: CP_PORT, host: '127.0.0.1' });

  // 5. Pre-provision the tenant so we can read the relay_token before spawning
  //    message-server.js. The provision endpoint has no outbound calls so no
  //    fetch interceptor is needed yet.
  const provRes = await fetch(`http://127.0.0.1:${CP_PORT}/v1/tenants/provision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slackTeamId: TEST_TEAM_ID, slackUserId: TEST_USER_ID }),
  });
  if (provRes.status !== 200) {
    throw new Error(`Pre-provision failed: ${provRes.status} ${await provRes.text()}`);
  }
  const { relayToken } = (await provRes.json()) as {
    tenantId: string;
    relayToken: string;
    status: string;
  };

  // 6. Create mock openclaw binary and spawn real message-server.js
  //    The mock openclaw drains stdin (prevents EPIPE) then writes JSON to stderr,
  //    matching the format openclaw --json produces.
  msTmpDir = join(os.tmpdir(), `full-chain-ms-${Date.now()}`);
  mkdirSync(msTmpDir, { recursive: true });

  const mockOpenclaw = join(msTmpDir, 'openclaw');
  writeFileSync(
    mockOpenclaw,
    `#!/bin/sh\ncat > /dev/null\necho '{"payloads":[{"text":"${AGENT_RESPONSE}","mediaUrl":null}]}' >&2\n`,
  );
  chmodSync(mockOpenclaw, 0o755);

  const msgServerSrc = readFileSync(
    join(process.cwd(), 'docker/tenant-image/message-server.js'),
    'utf8',
  );
  // Patch the default port so this instance doesn't collide with the in-container default
  const patchedSrc = msgServerSrc.replace(/const PORT = \d+;/, `const PORT = ${MS_PORT};`);

  msProcess = spawn(process.execPath, ['-e', patchedSrc], {
    env: {
      ...process.env,
      RELAY_TOKEN: relayToken,
      PATH: `${msTmpDir}:${process.env.PATH ?? ''}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  msProcess.stderr?.on('data', () => {});
  msProcess.stdout?.on('data', () => {});

  await waitForMsgServer(MS_PORT);

  // 7. Install fetch interceptor now that we know the relay_token and message-server is up.
  //    - :3101/health  → mock healthy (for pollUntilHealthy in CP)
  //    - :3100/message → route to locally-spawned real message-server (preserving headers/body)
  //    - slack.com/api/conversations.open → return mock DM channel
  //    - slack.com/api/chat.postMessage   → capture call
  //    - 127.0.0.1:CP_PORT               → pass through to real CP server
  const originalFetch = globalThis.fetch;

  const mockedFetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input instanceof URL ? input.toString() : input);

      if (url.includes(':3101/health')) {
        return new Response(JSON.stringify({ ok: true, status: 'healthy' }), { status: 200 });
      }

      // Route the CP's container call to the locally-spawned real message-server.
      // Preserve init (headers include x-relay-token, body contains the message).
      if (url.includes(':3100/message')) {
        return originalFetch(`http://127.0.0.1:${MS_PORT}/message`, init);
      }

      if (url.includes('slack.com/api/conversations.open')) {
        return new Response(
          JSON.stringify({ ok: true, channel: { id: 'D_FULL_CHAIN' } }),
          { status: 200 },
        );
      }

      if (url.includes('slack.com/api/chat.postMessage')) {
        const body = JSON.parse((init?.body as string) ?? '{}') as {
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

      if (
        url.includes(`127.0.0.1:${CP_PORT}`) ||
        url.includes(`localhost:${CP_PORT}`)
      ) {
        return originalFetch(input, init);
      }

      return originalFetch(input, init);
    },
  ) as unknown as typeof fetch;

  globalThis.fetch = mockedFetch;

  // 8. Build relay with the same mockedFetch so processSlackEventWithConfig uses it
  relayApp = await buildSlackRelayApp(
    {
      SLACK_RELAY_PORT: RELAY_PORT,
      SLACK_SIGNING_SECRET: SIGNING_SECRET,
      SLACK_BOT_TOKEN: BOT_TOKEN,
      CONTROL_PLANE_URL: `http://127.0.0.1:${CP_PORT}`,
    },
    mockedFetch,
    prisma,
  );
  await relayApp.listen({ port: RELAY_PORT, host: '127.0.0.1' });

  // 9. Send a Slack event through the relay
  const eventBody = JSON.stringify({
    type: 'event_callback',
    team_id: TEST_TEAM_ID,
    event_id: 'Ev_FULL_CHAIN_001',
    event: {
      user: TEST_USER_ID,
      type: 'message',
      text: 'Hello agent, what can you do?',
      channel: 'C_FULL_CHAIN',
    },
  });

  await relayApp.inject({
    method: 'POST',
    url: '/slack/events',
    headers: makeSlackHeaders(eventBody),
    payload: eventBody,
  });

  // Wait for tenant to reach ACTIVE before tests assert state
  const expectedTenantId = computeExpectedTenantId(TEST_TEAM_ID, TEST_USER_ID);
  await pollUntil(async () => {
    const tenant = await prisma.tenant.findUnique({ where: { id: expectedTenantId } });
    return tenant?.status === 'ACTIVE';
  }, 200, 30_000);
}, 60_000);

afterAll(async () => {
  if (relayApp) await relayApp.close().catch(() => {});
  if (cpApp) await cpApp.close().catch(() => {});
  if (prisma) await prisma.$disconnect().catch(() => {});

  if (msProcess) {
    msProcess.kill('SIGTERM');
    msProcess = null;
  }
  if (msTmpDir) {
    rmSync(msTmpDir, { recursive: true, force: true });
    msTmpDir = null;
  }

  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(tempDbPath);
  } catch { /* best-effort */ }

  try {
    const tenantId = computeExpectedTenantId(TEST_TEAM_ID, TEST_USER_ID);
    await rm(`${TEST_DATA_DIR}/${tenantId}`, { recursive: true, force: true });
  } catch { /* best-effort */ }
}, 30_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('E2E: Full chain — Slack → relay → CP → real message-server.js → mock openclaw → Slack DM', () => {
  const expectedTenantId = computeExpectedTenantId(TEST_TEAM_ID, TEST_USER_ID);

  it('tenant is provisioned and ACTIVE', async () => {
    const tenant = await prisma.tenant.findUnique({ where: { id: expectedTenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.status).toBe('ACTIVE');
  }, 10_000);

  it('message was delivered through real message-server.js (message_queue DELIVERED)', async () => {
    const delivered = await pollUntil(async () => {
      const rows = await prisma.messageQueue.findMany({
        where: { tenant_id: expectedTenantId, status: 'DELIVERED' },
      });
      return rows.length >= 1;
    }, 200, 20_000);

    expect(delivered).toBe(true);
    const row = await prisma.messageQueue.findFirst({
      where: { tenant_id: expectedTenantId, status: 'DELIVERED' },
    });
    expect(row).not.toBeNull();
  }, 25_000);

  it('Slack chat.postMessage was called with the agent reply from mock openclaw', async () => {
    const called = await pollUntil(async () => {
      return slackPostMessageCalls.some((c) => c.text === AGENT_RESPONSE);
    }, 100, 20_000);

    expect(called).toBe(true);
    const call = slackPostMessageCalls.find((c) => c.text === AGENT_RESPONSE);
    expect(call).toBeDefined();
    expect(call!.text).toBe(AGENT_RESPONSE);
  }, 25_000);

  it('audit log records TENANT_PROVISIONED → TENANT_STARTED → MESSAGE_DELIVERED in order', async () => {
    const allPresent = await pollUntil(async () => {
      const logs = await prisma.auditLog.findMany({
        where: {
          tenant_id: expectedTenantId,
          event_type: { in: ['TENANT_PROVISIONED', 'TENANT_STARTED', 'MESSAGE_DELIVERED'] },
        },
      });
      const types = logs.map((l) => l.event_type);
      return (
        types.includes('TENANT_PROVISIONED') &&
        types.includes('TENANT_STARTED') &&
        types.includes('MESSAGE_DELIVERED')
      );
    }, 200, 20_000);

    expect(allPresent).toBe(true);

    const logs = await prisma.auditLog.findMany({
      where: {
        tenant_id: expectedTenantId,
        event_type: { in: ['TENANT_PROVISIONED', 'TENANT_STARTED', 'MESSAGE_DELIVERED'] },
      },
      orderBy: { created_at: 'asc' },
    });

    const types = logs.map((l) => l.event_type);
    expect(types.indexOf('TENANT_PROVISIONED')).toBeLessThan(types.indexOf('TENANT_STARTED'));
    expect(types.indexOf('TENANT_STARTED')).toBeLessThan(types.indexOf('MESSAGE_DELIVERED'));
  }, 25_000);
});

/**
 * TC-025: Message queue deduplication → Slack retry is no-op
 *
 * Tests that the message queue properly deduplicates events using the
 * UNIQUE constraint on slack_event_id:
 * - enqueueMessage with event_id=Ev_DUP_001 creates exactly one PENDING row
 * - enqueueMessage with the same event_id (Slack retry) returns false — no duplicate row
 * - deliverPendingMessages delivers only once to the tenant runtime
 * - A second deliverPendingMessages call (after delivery) finds no PENDING rows → zero additional calls
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import {
  enqueueMessage,
  deliverPendingMessages,
  type Logger,
} from '../../apps/slack-relay/src/event-handler.js';

// Mock Date.now() to small incrementing counter to avoid SQLite Int32 overflow
let mockNow = 25_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);

// ─── Constants ────────────────────────────────────────────────────────────────

const DUPLICATE_EVENT_ID = 'Ev_DUP_001';
const TEST_TEAM_ID = 'T_TC025';
const TEST_USER_ID = 'U_TC025';

// ─── Test state ───────────────────────────────────────────────────────────────

let prisma: PrismaClient;
let tempDbPath: string;
let tenantId: string;
let relayToken: string;

const runtimeDeliveryCalls: Array<{ url: string; body: unknown }> = [];

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input instanceof URL ? input.toString() : input);
  if (url.includes(':3100/message')) {
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(init?.body as string ?? '{}');
    } catch {
      parsedBody = init?.body;
    }
    runtimeDeliveryCalls.push({ url, body: parsedBody });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  return new Response(JSON.stringify({ ok: false }), { status: 404 });
}) as unknown as typeof fetch;

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Create temp SQLite DB
  tempDbPath = `/tmp/test-tc025-${randomUUID()}.db`;
  const dbUrl = `file:${tempDbPath}`;

  const result = spawnSync(`${process.cwd()}/node_modules/.bin/prisma`, ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    shell: false,
    cwd: '/home/ubuntu/.openclaw/workspace/claw-orchestrator',
  });
  if (result.status !== 0) throw new Error('prisma db push failed: ' + result.stderr?.toString());

  // 2. Create PrismaClient
  prisma = new PrismaClient({ datasourceUrl: dbUrl });
  await prisma.$connect();

  // 3. Seed minimal tenant record (ACTIVE)
  tenantId = randomUUID().slice(0, 16);
  relayToken = randomUUID();

  await prisma.tenant.create({
    data: {
      id: tenantId,
      slack_team_id: TEST_TEAM_ID,
      slack_user_id: TEST_USER_ID,
      principal: `${TEST_TEAM_ID}:${TEST_USER_ID}`,
      status: 'ACTIVE',
      container_name: `claw-tenant-${tenantId}`,
      relay_token: relayToken,
      data_dir: `/tmp/claw-test-tenants/${tenantId}`,
      provision_attempts: 0,
      created_at: mockNow++,
      updated_at: mockNow++,
    },
  });
}, 60_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  try {
    await unlink(tempDbPath);
  } catch { /* best-effort */ }
}, 30_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TC-025: Message queue deduplication → Slack retry is no-op', () => {
  const payload = JSON.stringify({
    slackTeamId: TEST_TEAM_ID,
    slackUserId: TEST_USER_ID,
    slackEventId: DUPLICATE_EVENT_ID,
    text: 'Hello from TC-025',
  });

  it('TC-025: first enqueueMessage call creates exactly one PENDING row', async () => {
    const result = await enqueueMessage(prisma, tenantId, DUPLICATE_EVENT_ID, payload);

    expect(result).toBe(true);

    const rows = await prisma.messageQueue.findMany({
      where: { tenant_id: tenantId, slack_event_id: DUPLICATE_EVENT_ID },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('PENDING');
    expect(rows[0]!.slack_event_id).toBe(DUPLICATE_EVENT_ID);
  }, 10_000);

  it('TC-025: duplicate enqueueMessage (Slack retry) returns false — no new row', async () => {
    const result = await enqueueMessage(prisma, tenantId, DUPLICATE_EVENT_ID, payload);

    expect(result).toBe(false);

    const rows = await prisma.messageQueue.findMany({
      where: { tenant_id: tenantId, slack_event_id: DUPLICATE_EVENT_ID },
    });

    // Still exactly 1 row — the UNIQUE constraint prevented a duplicate
    expect(rows).toHaveLength(1);
  }, 10_000);

  it('TC-025: deliverPendingMessages delivers exactly once to tenant runtime', async () => {
    runtimeDeliveryCalls.length = 0;

    await deliverPendingMessages(prisma, tenantId, relayToken, mockLogger, mockFetch);

    // Exactly one HTTP call to the container runtime
    expect(runtimeDeliveryCalls).toHaveLength(1);
    expect(runtimeDeliveryCalls[0]!.url).toContain(':3100/message');

    // Row is now DELIVERED
    const row = await prisma.messageQueue.findFirst({
      where: { tenant_id: tenantId, slack_event_id: DUPLICATE_EVENT_ID },
    });
    expect(row).not.toBeNull();
    expect(row!.status).toBe('DELIVERED');
  }, 10_000);

  it('TC-025: second deliverPendingMessages call (after delivery) makes zero additional runtime calls', async () => {
    runtimeDeliveryCalls.length = 0;

    // Simulate Slack retry: enqueue again → returns false (no-op)
    const retryResult = await enqueueMessage(prisma, tenantId, DUPLICATE_EVENT_ID, payload);
    expect(retryResult).toBe(false);

    // deliverPendingMessages finds no PENDING rows → zero delivery attempts
    await deliverPendingMessages(prisma, tenantId, relayToken, mockLogger, mockFetch);
    expect(runtimeDeliveryCalls).toHaveLength(0);

    // Still only one row total
    const count = await prisma.messageQueue.count({
      where: { tenant_id: tenantId, slack_event_id: DUPLICATE_EVENT_ID },
    });
    expect(count).toBe(1);
  }, 10_000);
});

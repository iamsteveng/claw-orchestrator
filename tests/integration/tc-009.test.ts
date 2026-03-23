/**
 * TC-009: Disk quota → warning at 90%, block at 100%, auto-clear below 95%
 *
 * Verifies that checkDiskQuotas():
 *  - Writes DISK_QUOTA_WARNING audit event and sends Slack DM at 90%
 *  - Writes DISK_QUOTA_EXCEEDED audit event and sets disk_quota_exceeded=1 at 100%
 *  - POST /v1/tenants/:id/message returns 507 when disk_quota_exceeded=1
 *  - Clears disk_quota_exceeded=0 when usage drops below 95%
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { buildApp as BuildAppFn } from '../../apps/control-plane/src/app-factory.js';
import type { checkDiskQuotas as CheckDiskQuotasFn } from '../../apps/scheduler/src/disk-quota.js';

// Mock docker-client to prevent real docker calls
vi.mock('@claw/docker-client', () => ({
  DockerClient: {
    run: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue(null),
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  },
}));

// Mock health-poll to prevent real network calls during provisioning
vi.mock('../../apps/control-plane/src/health-poll.js', () => ({
  pollUntilHealthy: vi.fn().mockResolvedValue('healthy'),
}));

// Mock recovery to prevent real docker calls
vi.mock('../../apps/control-plane/src/recovery.js', () => ({
  attemptAutoRecovery: vi.fn().mockResolvedValue(undefined),
}));

// Mock Date.now() to avoid SQLite Int32 overflow.
// Sequence: TC-001: 3M, TC-002: 4M, TC-003: 5M, TC-004: 6M, TC-005: 7M, TC-006: 8M, TC-007: 9M, TC-008: 10M, TC-009: 11M
let mockNow = 11_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);

// ─── Constants ─────────────────────────────────────────────────────────────────

const QUOTA_BYTES = 12 * 1024 * 1024 * 1024; // 12 GB = 12884901888
// Math.floor(QUOTA_BYTES * 0.9) = 11596411699 bytes, which divided back gives 0.89999... < 0.9
// Use Math.ceil to guarantee ratio >= 0.9 threshold
const WARN_BYTES = Math.ceil(QUOTA_BYTES * 0.9);   // 90% — guaranteed >= WARN_THRESHOLD
const EXCEEDED_BYTES = QUOTA_BYTES;                 // 100%
const CLEAR_BYTES = Math.floor(QUOTA_BYTES * 0.8);  // 80% — well below 95% threshold

const TEST_TEAM_ID = 'T_TC009';
const TEST_USER_ID = 'U_TC009';
const TEST_DATA_DIR = '/tmp/claw-tc009-isolated';

// ─── Test State ────────────────────────────────────────────────────────────────

let app: FastifyInstance;
let prisma: PrismaClient;
let tempDbPath: string;
let tenantId: string;
let relayToken: string;
let checkDiskQuotas: typeof CheckDiskQuotasFn;

// Silent logger
const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// Slack API fetch mock
function makeFetchMock() {
  return vi.fn().mockImplementation((url: string) => {
    if (String(url).includes('conversations.open')) {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, channel: { id: 'D_TC009' } }), { status: 200 }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
  });
}

// ─── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  vi.stubEnv('DATA_DIR', TEST_DATA_DIR);
  vi.resetModules();

  tempDbPath = `/tmp/test-tc009-${randomUUID()}.db`;
  const dbUrl = `file:${tempDbPath}`;

  await mkdir(TEST_DATA_DIR, { recursive: true });

  const result = spawnSync(`${process.cwd()}/node_modules/.bin/prisma`, ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    shell: false,
    cwd: '/home/ubuntu/.openclaw/workspace/claw-orchestrator',
  });
  if (result.status !== 0) throw new Error('prisma db push failed: ' + result.stderr?.toString());

  prisma = new PrismaClient({ datasourceUrl: dbUrl });
  await prisma.$connect();

  // Seed default container image
  await prisma.containerImage.create({
    data: {
      id: randomUUID(),
      tag: 'claw-tenant:test',
      is_default: 1,
      created_at: mockNow++,
    },
  });

  // Seed allowlist
  await prisma.allowlist.create({
    data: {
      id: randomUUID(),
      slack_team_id: TEST_TEAM_ID,
      slack_user_id: null,
      added_by: 'tc-009-setup',
      created_at: mockNow++,
    },
  });

  // Dynamic imports AFTER resetModules
  const { buildApp } = await import('../../apps/control-plane/src/app-factory.js') as {
    buildApp: typeof BuildAppFn;
  };

  app = await buildApp(prisma, { logger: false });
  await app.ready();

  // Provision tenant via API
  const provRes = await app.inject({
    method: 'POST',
    url: '/v1/tenants/provision',
    payload: { slackTeamId: TEST_TEAM_ID, slackUserId: TEST_USER_ID },
  });
  expect(provRes.statusCode).toBe(200);
  const body = provRes.json<{ tenantId: string; relayToken: string }>();
  tenantId = body.tenantId;
  relayToken = body.relayToken;

  // Force ACTIVE status (provisioning mock doesn't fully activate)
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { status: 'ACTIVE', updated_at: mockNow++ },
  });

  // Import checkDiskQuotas after module reset
  const schedulerMod = await import('../../apps/scheduler/src/disk-quota.js') as {
    checkDiskQuotas: typeof CheckDiskQuotasFn;
  };
  checkDiskQuotas = schedulerMod.checkDiskQuotas;
}, 60_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  if (app) await app.close();
  if (prisma) await prisma.$disconnect();

  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(tempDbPath);
  } catch { /* best-effort */ }

  try {
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
  } catch { /* best-effort */ }
}, 30_000);

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('TC-009: Disk quota → warning at 90%, block at 100%, auto-clear below 95%', () => {
  it('TC-009: warning at 90% — DISK_QUOTA_WARNING audit event written and Slack DM sent', async () => {
    const fetchMock = makeFetchMock();
    const getDiskFn = vi.fn().mockResolvedValue(WARN_BYTES); // 90%

    await checkDiskQuotas(prisma, 'xoxb-test-token', log, getDiskFn, fetchMock as unknown as typeof fetch);

    // Assert DISK_QUOTA_WARNING audit event
    const auditLog = await prisma.auditLog.findFirst({
      where: { tenant_id: tenantId, event_type: 'DISK_QUOTA_WARNING' },
    });
    expect(auditLog).not.toBeNull();
    expect(auditLog!.actor).toBe('scheduler');

    // Verify metadata contains usedBytes
    const metadata = JSON.parse(auditLog!.metadata ?? '{}') as {
      usedBytes?: number;
      quotaBytes?: number;
      ratio?: number;
    };
    expect(metadata.usedBytes).toBe(WARN_BYTES);
    expect(metadata.quotaBytes).toBe(QUOTA_BYTES);

    // Assert Slack DM was sent (cleanup suggestion)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('conversations.open'),
      expect.anything(),
    );
    const postMessageCall = fetchMock.mock.calls.find(
      (call) => String(call[0]).includes('chat.postMessage'),
    );
    expect(postMessageCall).toBeDefined();
    const postBody = JSON.parse((postMessageCall![1] as { body: string }).body) as { text: string };
    expect(postBody.text).toContain('rm -rf');

    // disk_quota_exceeded must NOT be set at warning level
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant!.disk_quota_exceeded).toBe(0);
  });

  it('TC-009: exceeded at 100% — DISK_QUOTA_EXCEEDED audit event written and disk_quota_exceeded=1', async () => {
    const fetchMock = makeFetchMock();
    const getDiskFn = vi.fn().mockResolvedValue(EXCEEDED_BYTES); // 100%

    await checkDiskQuotas(prisma, 'xoxb-test-token', log, getDiskFn, fetchMock as unknown as typeof fetch);

    // Assert DISK_QUOTA_EXCEEDED audit event
    const auditLog = await prisma.auditLog.findFirst({
      where: { tenant_id: tenantId, event_type: 'DISK_QUOTA_EXCEEDED' },
    });
    expect(auditLog).not.toBeNull();
    expect(auditLog!.actor).toBe('scheduler');

    // Assert disk_quota_exceeded flag is set
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant!.disk_quota_exceeded).toBe(1);

    // Assert Slack DM was sent with quota exceeded message
    const postMessageCall = fetchMock.mock.calls.find(
      (call) => String(call[0]).includes('chat.postMessage'),
    );
    expect(postMessageCall).toBeDefined();
    const postBody = JSON.parse((postMessageCall![1] as { body: string }).body) as { text: string };
    expect(postBody.text).toContain('disk quota');
  });

  it('TC-009: POST /v1/tenants/:id/message returns 507 while disk_quota_exceeded=1', async () => {
    // Verify disk_quota_exceeded is currently 1 from the previous test
    const tenantBefore = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenantBefore!.disk_quota_exceeded).toBe(1);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/message`,
      headers: { 'x-relay-token': relayToken },
      payload: {
        messageId: randomUUID(),
        slackEventId: `Ev_TC009_${randomUUID().slice(0, 8)}`,
        userId: TEST_USER_ID,
        teamId: TEST_TEAM_ID,
        text: 'hello',
        slackPayload: {},
        timestamp: mockNow++,
      },
    });

    expect(res.statusCode).toBe(507);
    expect(res.json()).toMatchObject({ ok: false, error: 'Disk quota exceeded' });
  });

  it('TC-009: auto-clear below 95% — disk_quota_exceeded reset to 0', async () => {
    const fetchMock = makeFetchMock();
    const getDiskFn = vi.fn().mockResolvedValue(CLEAR_BYTES); // 80% — below 95%

    await checkDiskQuotas(prisma, 'xoxb-test-token', log, getDiskFn, fetchMock as unknown as typeof fetch);

    // Assert disk_quota_exceeded flag is cleared
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant!.disk_quota_exceeded).toBe(0);

    // No new DISK_QUOTA_WARNING or DISK_QUOTA_EXCEEDED events
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('chat.postMessage'),
      expect.anything(),
    );
  });
});

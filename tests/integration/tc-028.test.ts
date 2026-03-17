/**
 * TC-028: UNHEALTHY auto-recovery → tenant recovers and queued messages processed
 *
 * Tests the full UNHEALTHY→recovery flow using monitorTenantHealth:
 *  1. Provision and activate tenant
 *  2. Queue 2 messages in DB
 *  3. Run monitorTenantHealth with 3 consecutive health check failures → UNHEALTHY
 *  4. Assert TENANT_UNHEALTHY audit event
 *  5. Assert Slack DM sent (notifyUser called)
 *  6. Mock health endpoint to return healthy after 30s cooldown
 *  7. Assert tenant returns to ACTIVE
 *  8. Assert TENANT_RECOVERED audit event
 *  9. Assert queued messages not dropped (still PENDING, replayMessages triggered)
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';

// ─── Module-level mock timestamp ─────────────────────────────────────────────

let mockNow = 28_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockDockerClient = {
  run: vi.fn().mockResolvedValue(undefined),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  inspect: vi.fn().mockResolvedValue(null),
  exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
};

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

vi.mock('../../apps/control-plane/src/seed-workspace.js', () => ({
  seedWorkspace: vi.fn().mockResolvedValue(undefined),
}));

// pollUntilHealthy mock: handles both initial startup and recovery path.
// Always activates tenant → ACTIVE and writes TENANT_STARTED.
vi.mock('../../apps/control-plane/src/health-poll.js', () => ({
  pollUntilHealthy: vi.fn().mockImplementation(
    async (
      prisma: import('@prisma/client').PrismaClient,
      tenantId: string,
      containerName: string,
    ) => {
      const now = mockNow++;
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { status: 'ACTIVE', last_started_at: now, updated_at: now },
      });
      await prisma.auditLog.create({
        data: {
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          event_type: 'TENANT_STARTED',
          actor: 'system',
          metadata: JSON.stringify({ containerName }),
          created_at: now,
        },
      });
      return 'healthy';
    },
  ),
}));

import { buildApp } from '../../apps/control-plane/src/app-factory.js';
import { monitorTenantHealth } from '../../apps/control-plane/src/health-monitor.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_TEAM_ID = 'T_TC028';
const TEST_USER_ID = 'U_RECOVER';
const TEST_DATA_DIR = process.env.DATA_DIR!;

// ─── Test State ───────────────────────────────────────────────────────────────

let app: FastifyInstance;
let prisma: PrismaClient;
let tempDbPath: string;
let tenantId: string;
let containerName: string;
let tenantDataDir: string;

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  tempDbPath = `/tmp/test-tc028-${randomUUID()}.db`;
  const dbUrl = `file:${tempDbPath}`;

  await mkdir(TEST_DATA_DIR, { recursive: true });

  execSync('npx prisma db push --skip-generate', {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    cwd: '/home/ubuntu/.openclaw/workspace/claw-orchestrator',
  });

  prisma = new PrismaClient({ datasourceUrl: dbUrl });
  await prisma.$connect();

  // Seed default container image (required by /start endpoint)
  await prisma.containerImage.create({
    data: {
      id: randomUUID(),
      tag: 'claw-tenant:tc028',
      is_default: 1,
      created_at: mockNow++,
    },
  });

  app = await buildApp(prisma, { logger: false, dockerClient: mockDockerClient });
  await app.ready();
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (prisma) await prisma.$disconnect();

  // Clean up only this test's tenant data dir
  if (tenantDataDir) {
    try {
      await rm(tenantDataDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }

  // Clean up temp DB
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(tempDbPath);
  } catch { /* best-effort */ }
}, 30_000);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TC-028: UNHEALTHY auto-recovery → tenant recovers and queued messages processed', () => {
  // ── 1. Add allowlist entry ─────────────────────────────────────────────────

  it('TC-028: POST /v1/admin/allowlist adds U_RECOVER to allowlist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/allowlist',
      payload: {
        slack_team_id: TEST_TEAM_ID,
        slack_user_id: TEST_USER_ID,
        added_by: 'admin:tc028',
      },
    });

    expect(res.statusCode, `Expected 200, got ${res.statusCode}: ${res.body}`).toBe(200);
    const body = res.json<{ id: string }>();
    expect(body.id).toBeTruthy();
  });

  // ── 2. Provision tenant ────────────────────────────────────────────────────

  it('TC-028: POST /v1/tenants/provision succeeds for allowlisted U_RECOVER', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants/provision',
      payload: { slackTeamId: TEST_TEAM_ID, slackUserId: TEST_USER_ID },
    });

    expect(res.statusCode, `Expected 200, got ${res.statusCode}: ${res.body}`).toBe(200);
    const body = res.json<{ tenantId: string; status: string }>();
    tenantId = body.tenantId;
    containerName = `claw-tenant-${tenantId}`;
    expect(body.status).toBe('NEW');

    // Capture data_dir for cleanup
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    tenantDataDir = tenant!.data_dir;
  });

  // ── 3. Start tenant and wait for ACTIVE ───────────────────────────────────

  it('TC-028: POST /v1/tenants/:id/start activates tenant', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/start`,
    });

    expect(
      res.statusCode,
      `Start returned ${res.statusCode}: ${res.body}`,
    ).toSatisfy((s: number) => s === 200 || s === 202);

    // Flush microtask queue so pollUntilHealthy mock completes
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant!.status).toBe('ACTIVE');
  });

  // ── 4. Queue 2 messages while tenant is ACTIVE (will persist through UNHEALTHY) ─

  it('TC-028: 2 messages queued in DB (PENDING)', async () => {
    await prisma.messageQueue.create({
      data: {
        id: randomUUID(),
        tenant_id: tenantId,
        slack_event_id: 'EVT_TC028_001',
        payload: JSON.stringify({ slackEventId: 'EVT_TC028_001', text: 'Queued message 1' }),
        status: 'PENDING',
        attempts: 0,
        created_at: mockNow++,
        updated_at: mockNow++,
      },
    });

    await prisma.messageQueue.create({
      data: {
        id: randomUUID(),
        tenant_id: tenantId,
        slack_event_id: 'EVT_TC028_002',
        payload: JSON.stringify({ slackEventId: 'EVT_TC028_002', text: 'Queued message 2' }),
        status: 'PENDING',
        attempts: 0,
        created_at: mockNow++,
        updated_at: mockNow++,
      },
    });

    const messages = await prisma.messageQueue.findMany({
      where: { tenant_id: tenantId },
    });
    expect(messages).toHaveLength(2);
    expect(messages.every(m => m.status === 'PENDING')).toBe(true);
  });

  // ── 5. monitorTenantHealth: UNHEALTHY detection → Slack DM → recovery → ACTIVE ─

  it('TC-028: monitorTenantHealth detects 3 failures → UNHEALTHY → notifies → recovers → ACTIVE + TENANT_RECOVERED + queued messages not dropped', async () => {
    // Fake timers for setTimeout only; keep our Date.now spy intact
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });

    // Mock fetch for health endpoint: first 3 calls fail, then healthy
    let healthFetchCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      healthFetchCount++;
      if (healthFetchCount <= 3) {
        throw new Error('ECONNREFUSED');
      }
      // After cooldown, health check succeeds (used by pollUntilHealthy mock path)
      return {
        ok: true,
        json: async () => ({ ok: true }),
      };
    }));

    const notifyUserSpy = vi.fn().mockResolvedValue(undefined);
    const replayMessagesSpy = vi.fn().mockResolvedValue(undefined);
    const mockLog = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    // Start health monitoring in background (as it would run in production)
    const monitorPromise = monitorTenantHealth(
      prisma,
      tenantId,
      containerName,
      TEST_USER_ID,
      notifyUserSpy,
      replayMessagesSpy,
      mockLog,
    );

    // Advance all timers: runs through poll failures, 30s cooldown, and recovery
    await vi.runAllTimersAsync();
    await monitorPromise;

    // ── Assert TENANT_UNHEALTHY audit event ──────────────────────────────────
    const unhealthyAudit = await prisma.auditLog.findFirst({
      where: { tenant_id: tenantId, event_type: 'TENANT_UNHEALTHY' },
    });
    expect(unhealthyAudit, 'TENANT_UNHEALTHY audit event should be written').not.toBeNull();

    // ── Assert Slack DM sent about recovery attempt ──────────────────────────
    expect(notifyUserSpy, 'notifyUser (Slack DM) should be called at least once').toHaveBeenCalled();
    expect(notifyUserSpy).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.stringContaining('experiencing issues'),
    );

    // ── Assert tenant returned to ACTIVE ─────────────────────────────────────
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant!.status, 'Tenant should be ACTIVE after auto-recovery').toBe('ACTIVE');

    // ── Assert TENANT_RECOVERED audit event ───────────────────────────────────
    const recoveredAudit = await prisma.auditLog.findFirst({
      where: { tenant_id: tenantId, event_type: 'TENANT_RECOVERED' },
    });
    expect(recoveredAudit, 'TENANT_RECOVERED audit event should be written').not.toBeNull();

    // ── Assert replayMessages called (queued messages triggered for replay) ───
    expect(replayMessagesSpy, 'replayMessages should be called with tenantId after recovery').toHaveBeenCalledWith(tenantId);

    // ── Assert queued messages not dropped ────────────────────────────────────
    const messages = await prisma.messageQueue.findMany({
      where: { tenant_id: tenantId },
    });
    expect(messages, 'Both queued messages should still exist (not dropped)').toHaveLength(2);
    expect(
      messages.every(m => m.status === 'PENDING'),
      'Queued messages should remain PENDING after recovery (not dropped/failed)',
    ).toBe(true);
  }, 30_000);
});

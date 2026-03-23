/**
 * TC-010: Idle stop → container stopped after 48h inactivity
 *
 * Verifies that stopIdleTenants():
 *  - Calls POST /v1/tenants/:id/stop for ACTIVE tenants idle > 48h
 *  - Sets tenant status to STOPPED
 *  - Writes TENANT_STOPPED audit event with actor=scheduler
 *  - Does NOT stop tenants active within the last 48h
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { stopIdleTenants as StopIdleTenantsFn } from '../../apps/scheduler/src/idle-stop.js';

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

// Mock health-poll to prevent real network calls
vi.mock('../../apps/control-plane/src/health-poll.js', () => ({
  pollUntilHealthy: vi.fn().mockResolvedValue('healthy'),
}));

// Mock recovery to prevent real docker calls
vi.mock('../../apps/control-plane/src/recovery.js', () => ({
  attemptAutoRecovery: vi.fn().mockResolvedValue(undefined),
}));

// Mock Date.now() — needs to be large enough to allow 49h lookback without negative timestamps.
// 49h = 176_400_000 ms, so mockNow must be > 176_400_000.
// Use 200_000_000 as the baseline (fits comfortably in SQLite 32-bit INT, max ~2.1 billion).
let mockNow = 200_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);

// ─── Constants ─────────────────────────────────────────────────────────────────

const IDLE_STOP_MS = 48 * 60 * 60 * 1000; // 48 hours in ms

const TEST_DATA_DIR = '/tmp/claw-tc010-isolated';
const TEST_TEAM_ID = 'T_TC010';

// ─── Test State ────────────────────────────────────────────────────────────────

let app: FastifyInstance;
let prisma: PrismaClient;
let tempDbPath: string;
let stopIdleTenants: typeof StopIdleTenantsFn;

let idleTenantId: string;   // last_activity_at = 49h ago → should be stopped
let recentTenantId: string; // last_activity_at = 47h ago → should NOT be stopped

// Silent logger
const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Creates a fetch-like function that routes /v1/tenants/:id/stop calls
 * through the Fastify app.inject() so no real HTTP server is needed.
 */
function makeAppFetch(appInstance: FastifyInstance): typeof fetch {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = String(url);
    const stopMatch = urlStr.match(/\/v1\/tenants\/([^/]+)\/stop/);
    if (stopMatch) {
      const tenantId = stopMatch[1];
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
      const res = await appInstance.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/stop`,
        payload: body,
      });
      return new Response(res.body, { status: res.statusCode });
    }
    throw new Error(`TC-010: Unexpected URL in fetchFn: ${urlStr}`);
  };
}

async function seedActiveTenant(
  teamId: string,
  userId: string,
  lastActivityAt: number,
): Promise<string> {
  const id = randomUUID().slice(0, 16);
  const now = mockNow++;
  await prisma.tenant.create({
    data: {
      id,
      principal: `${teamId}:${userId}`,
      slack_team_id: teamId,
      slack_user_id: userId,
      status: 'ACTIVE',
      relay_token: randomUUID(),
      container_name: `claw-tenant-${id}`,
      data_dir: `${TEST_DATA_DIR}/${id}`,
      provision_attempts: 1,
      last_activity_at: lastActivityAt,
      created_at: now,
      updated_at: now,
    },
  });
  return id;
}

// ─── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  vi.stubEnv('DATA_DIR', TEST_DATA_DIR);
  vi.resetModules();

  tempDbPath = `/tmp/test-tc010-${randomUUID()}.db`;
  const dbUrl = `file:${tempDbPath}`;

  await mkdir(TEST_DATA_DIR, { recursive: true });

  execSync(`${process.cwd()}/node_modules/.bin/prisma db push --skip-generate`, {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    cwd: '/home/ubuntu/.openclaw/workspace/claw-orchestrator',
  });

  prisma = new PrismaClient({ datasourceUrl: dbUrl });
  await prisma.$connect();

  // Dynamic imports AFTER resetModules so mocks are effective
  const { buildApp } = await import('../../apps/control-plane/src/app-factory.js') as {
    buildApp: (prisma: PrismaClient, opts?: unknown) => Promise<FastifyInstance>;
  };

  app = await buildApp(prisma, { logger: false });
  await app.ready();

  const schedulerMod = await import('../../apps/scheduler/src/idle-stop.js') as {
    stopIdleTenants: typeof StopIdleTenantsFn;
  };
  stopIdleTenants = schedulerMod.stopIdleTenants;

  // Capture the "current" mock time so we can compute 49h and 47h offsets.
  // Any subsequent mockNow increments from Date.now() calls are fine.
  const baseTime = mockNow;

  // Idle tenant: last_activity_at = 49h before baseTime
  const HOURS_49_MS = 49 * 60 * 60 * 1000;
  const HOURS_47_MS = 47 * 60 * 60 * 1000;

  idleTenantId = await seedActiveTenant(TEST_TEAM_ID, 'U_TC010_IDLE', baseTime - HOURS_49_MS);
  recentTenantId = await seedActiveTenant(TEST_TEAM_ID, 'U_TC010_RECENT', baseTime - HOURS_47_MS);
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

describe('TC-010: Idle stop → container stopped after 48h inactivity', () => {
  it('TC-010: idle tenant (49h) → stop called, status=STOPPED, TENANT_STOPPED audit with actor=scheduler', async () => {
    const fetchFn = makeAppFetch(app);

    await stopIdleTenants(prisma, 'http://localhost', IDLE_STOP_MS, log, fetchFn);

    // Assert idle tenant status is STOPPED
    const idleTenant = await prisma.tenant.findUnique({ where: { id: idleTenantId } });
    expect(idleTenant).not.toBeNull();
    expect(idleTenant!.status).toBe('STOPPED');

    // Assert TENANT_STOPPED audit event with actor=scheduler
    const auditLog = await prisma.auditLog.findFirst({
      where: { tenant_id: idleTenantId, event_type: 'TENANT_STOPPED' },
    });
    expect(auditLog).not.toBeNull();
    expect(auditLog!.actor).toBe('scheduler');

    // Assert the scheduler logger was invoked (stop was processed)
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: idleTenantId }),
      'Idle tenant stopped by scheduler',
    );
  });

  it('TC-010: recent tenant (47h) → NOT stopped, status remains ACTIVE', async () => {
    // Recent tenant should still be ACTIVE (not stopped by the idle-stop run above)
    const recentTenant = await prisma.tenant.findUnique({ where: { id: recentTenantId } });
    expect(recentTenant).not.toBeNull();
    expect(recentTenant!.status).toBe('ACTIVE');

    // No TENANT_STOPPED audit event for the recent tenant
    const auditLog = await prisma.auditLog.findFirst({
      where: { tenant_id: recentTenantId, event_type: 'TENANT_STOPPED' },
    });
    expect(auditLog).toBeNull();
  });
});

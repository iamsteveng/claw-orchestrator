/**
 * TC-008: Health polling → UNHEALTHY detection
 *
 * Verifies that pollUntilHealthy():
 *  - Detects 3 consecutive health check failures for an ACTIVE tenant
 *  - Transitions tenant status to UNHEALTHY
 *  - Writes a TENANT_UNHEALTHY audit log entry with reason
 *  - Does NOT affect other tenants
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { pollUntilHealthy as PollUntilHealthyFn } from '../../apps/control-plane/src/health-poll.js';

// Mock recovery module to prevent actual docker/network calls in this integration test
vi.mock('../../apps/control-plane/src/recovery.js', () => ({
  attemptAutoRecovery: vi.fn().mockResolvedValue(undefined),
}));

// Mock Date.now() to avoid SQLite Int32 overflow.
// Sequence: TC-001: 3M, TC-002: 4M, TC-003: 5M, TC-004: 6M, TC-005: 7M, TC-006: 8M, TC-007: 9M, TC-008: 10M
let mockNow = 10_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);

// ─── Test State ────────────────────────────────────────────────────────────────

let prisma: PrismaClient;
let tempDbPath: string;
let pollUntilHealthy: typeof PollUntilHealthyFn;

// Private data dir (this test doesn't use DATA_DIR but isolating avoids any edge cases)
const TEST_DATA_DIR = '/tmp/claw-tc008-isolated';

const TEST_TEAM_ID = 'T_TC008';
const TEST_USER_ID_A = 'U_TC008_A';   // tenant under test
const TEST_USER_ID_B = 'U_TC008_B';   // "other" tenant — must be unaffected

let tenantAId: string;
let tenantAContainerName: string;
let tenantBId: string;

// Silent logger
const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  vi.stubEnv('DATA_DIR', TEST_DATA_DIR);
  vi.resetModules();

  // Create isolated temp SQLite DB
  tempDbPath = `/tmp/test-tc008-${randomUUID()}.db`;
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

  // Import pollUntilHealthy AFTER resetModules so recovery mock is effective
  const mod = await import('../../apps/control-plane/src/health-poll.js') as {
    pollUntilHealthy: typeof PollUntilHealthyFn;
  };
  pollUntilHealthy = mod.pollUntilHealthy;

  // Seed two ACTIVE tenants directly in DB (no HTTP layer needed)
  const seedTenant = async (teamId: string, userId: string) => {
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
        created_at: now,
        updated_at: now,
      },
    });
    return id;
  };

  tenantAId = await seedTenant(TEST_TEAM_ID, TEST_USER_ID_A);
  tenantAContainerName = `claw-tenant-${tenantAId}`;
  tenantBId = await seedTenant(TEST_TEAM_ID, TEST_USER_ID_B);
}, 60_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  if (prisma) await prisma.$disconnect();

  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(tempDbPath);
  } catch { /* best-effort */ }

  try {
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
  } catch { /* best-effort */ }
}, 30_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TC-008: Health polling → UNHEALTHY detection', () => {
  it('TC-008: health polling detects 3 consecutive failures → tenant transitions to UNHEALTHY', async () => {
    // Mock fetch to always return HTTP 503 (simulates container health endpoint down)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ ok: false }),
    }));

    // Use fake timers to fast-forward through poll intervals
    vi.useFakeTimers();

    const pollPromise = pollUntilHealthy(prisma, tenantAId, tenantAContainerName, 'ACTIVE', log);

    // Advance all timers to trigger 3 consecutive poll failures quickly
    await vi.runAllTimersAsync();
    const result = await pollPromise;

    vi.useRealTimers();
    vi.unstubAllGlobals();

    expect(result).toBe('timeout');

    // ── Assert tenant A status is UNHEALTHY ────────────────────────────────────
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantAId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.status).toBe('UNHEALTHY');
  });

  it('TC-008: TENANT_UNHEALTHY audit log entry written with reason=consecutive_failures', async () => {
    // Audit log should have been written by the previous test's pollUntilHealthy call
    const auditLog = await prisma.auditLog.findFirst({
      where: {
        tenant_id: tenantAId,
        event_type: 'TENANT_UNHEALTHY',
      },
    });

    expect(auditLog).not.toBeNull();
    expect(auditLog!.actor).toBe('system');

    // Verify metadata contains reason
    const metadata = JSON.parse(auditLog!.metadata ?? '{}') as {
      reason?: string;
      containerName?: string;
    };
    expect(metadata.reason).toBe('consecutive_failures');
    expect(metadata.containerName).toBe(tenantAContainerName);
  });

  it('TC-008: UNHEALTHY state does not affect other tenants (isolation)', async () => {
    // Tenant B should still be ACTIVE — pollUntilHealthy only touched tenant A
    const tenantB = await prisma.tenant.findUnique({ where: { id: tenantBId } });
    expect(tenantB).not.toBeNull();
    expect(tenantB!.status).toBe('ACTIVE');

    // No TENANT_UNHEALTHY audit log for tenant B
    const auditLogB = await prisma.auditLog.findFirst({
      where: {
        tenant_id: tenantBId,
        event_type: 'TENANT_UNHEALTHY',
      },
    });
    expect(auditLogB).toBeNull();
  });
});

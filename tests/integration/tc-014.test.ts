/**
 * TC-014: Provisioning rollback → cleanup on failure
 *
 * Verifies that when provisioning fails (seedWorkspace throws):
 *  1. Tenant status is set to FAILED
 *  2. provision_attempts is incremented to 1
 *  3. data_dir directory is removed (rollback cleanup)
 *  4. TENANT_PROVISION_FAILED audit log entry is written
 *  5. When provision_attempts reaches 3, provision returns HTTP 409
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, access } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';

// Mock seedWorkspace to throw a simulated failure for all provision attempts
vi.mock('../../apps/control-plane/src/seed-workspace.js', () => ({
  seedWorkspace: vi.fn().mockRejectedValue(new Error('Simulated seedWorkspace failure')),
}));

// Mock docker-client (provision itself does not call docker.run, but buildApp imports it)
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

// Mock health-poll to prevent background network calls during any accidental /start calls
vi.mock('../../apps/control-plane/src/health-poll.js', () => ({
  pollUntilHealthy: vi.fn().mockResolvedValue('healthy'),
}));

// Use small incrementing mock timestamps to stay well within SQLite Int32 range
let mockNow = 14_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);

// Import buildApp AFTER vi.mock declarations (vi.mock is hoisted, import after)
import { buildApp } from '../../apps/control-plane/src/app-factory.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_TEAM_ID = 'T_TC014';
const TEST_USER_ID = 'U_TC014';

// Use process.env.DATA_DIR set by vitest-setup.ts (/tmp/claw-test-tenants)
// but we'll only clean up our specific tenant dir, not the whole base dir.
const TEST_DATA_DIR = process.env.DATA_DIR!;

// ─── Test State ───────────────────────────────────────────────────────────────

let app: FastifyInstance;
let prisma: PrismaClient;
let tempDbPath: string;

// Computed once in the first test, used in all subsequent tests
let tenantId: string;
let dataDir: string;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Create isolated temp SQLite DB
  tempDbPath = `/tmp/test-tc014-${randomUUID()}.db`;
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

  // Seed allowlist for TC-014 team
  await prisma.allowlist.create({
    data: {
      id: randomUUID(),
      slack_team_id: TEST_TEAM_ID,
      slack_user_id: null,
      added_by: 'tc-014-setup',
      created_at: mockNow++,
    },
  });

  app = await buildApp(prisma, { logger: false });
  await app.ready();
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (prisma) await prisma.$disconnect();

  // Clean up only the specific tenant dir created by this test
  if (dataDir) {
    try {
      await rm(dataDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }

  // Clean up temp DB
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(tempDbPath);
  } catch { /* best-effort */ }
}, 30_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TC-014: Provisioning rollback → cleanup on failure', () => {
  it('TC-014: provision fails → HTTP 500 returned', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants/provision',
      payload: { slackTeamId: TEST_TEAM_ID, slackUserId: TEST_USER_ID },
    });

    expect(res.statusCode).toBe(500);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe('Provisioning failed');
  });

  it('TC-014: tenant status = FAILED after rollback', async () => {
    const principal = `${TEST_TEAM_ID}:${TEST_USER_ID}`;
    const tenant = await prisma.tenant.findUnique({ where: { principal } });

    expect(tenant).not.toBeNull();
    tenantId = tenant!.id;
    dataDir = tenant!.data_dir;

    expect(tenant!.status).toBe('FAILED');
  });

  it('TC-014: provision_attempts = 1 after first failure', async () => {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.provision_attempts).toBe(1);
  });

  it('TC-014: data_dir directory does NOT exist (cleaned up by rollback)', async () => {
    expect(await pathExists(dataDir)).toBe(false);
  });

  it('TC-014: TENANT_PROVISION_FAILED audit log entry exists', async () => {
    const audit = await prisma.auditLog.findFirst({
      where: {
        tenant_id: tenantId,
        event_type: 'TENANT_PROVISION_FAILED',
      },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actor).toBe('system');
  });

  it('TC-014: TENANT_PROVISIONED audit log entry does NOT exist (no success)', async () => {
    const audit = await prisma.auditLog.findFirst({
      where: {
        tenant_id: tenantId,
        event_type: 'TENANT_PROVISIONED',
      },
    });
    expect(audit).toBeNull();
  });

  it('TC-014: retry provision (attempts < 3) → returns 200 with FAILED status', async () => {
    // Re-calling provision for a FAILED tenant with < 3 attempts returns the
    // existing record (no re-provision attempted) without 409
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants/provision',
      payload: { slackTeamId: TEST_TEAM_ID, slackUserId: TEST_USER_ID },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string }>();
    expect(body.status).toBe('FAILED');
  });

  it('TC-014: provision_attempts still = 1 (returning existing record, no re-attempt)', async () => {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant!.provision_attempts).toBe(1);
  });

  it('TC-014: directly set attempts=2, provision → still 200 FAILED (cap not yet hit)', async () => {
    // Simulate second external attempt by directly updating DB
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { provision_attempts: 2, updated_at: mockNow++ },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants/provision',
      payload: { slackTeamId: TEST_TEAM_ID, slackUserId: TEST_USER_ID },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string }>();
    expect(body.status).toBe('FAILED');
  });

  it('TC-014: set attempts=3 → provision returns HTTP 409 (cap enforced)', async () => {
    // Simulate third failure recorded externally
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { provision_attempts: 3, updated_at: mockNow++ },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants/provision',
      payload: { slackTeamId: TEST_TEAM_ID, slackUserId: TEST_USER_ID },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe('Max provision attempts reached');
  });

  it('TC-014: tenant status permanently FAILED with attempts >= 3', async () => {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.status).toBe('FAILED');
    expect(tenant!.provision_attempts).toBeGreaterThanOrEqual(3);
  });
});

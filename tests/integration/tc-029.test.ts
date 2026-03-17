/**
 * TC-029: Provision endpoint idempotency → same tenant on duplicate call
 *
 * Verifies that calling POST /v1/tenants/provision twice for the same
 * (slackTeamId, slackUserId) principal is idempotent:
 *  1. Add allowlist entry for (T_TC029, U_IDEMPOTENT)
 *  2. POST /v1/tenants/provision → assert tenant created (NEW status)
 *  3. POST /v1/tenants/provision again with same principal
 *  4. Assert same tenantId returned
 *  5. Assert only 1 tenant row in DB for this principal
 *  6. Assert no new audit events written on idempotent call
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';

// ─── Module-level mock timestamp ─────────────────────────────────────────────

let mockNow = 29_000_000;
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

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_TEAM_ID = 'T_TC029';
const TEST_USER_ID = 'U_IDEMPOTENT';
const TEST_DATA_DIR = process.env.DATA_DIR!;

// ─── Test State ───────────────────────────────────────────────────────────────

let app: FastifyInstance;
let prisma: PrismaClient;
let tempDbPath: string;
let tenantId: string;
let tenantDataDir: string;

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  tempDbPath = `/tmp/test-tc029-${randomUUID()}.db`;
  const dbUrl = `file:${tempDbPath}`;

  await mkdir(TEST_DATA_DIR, { recursive: true });

  execSync('npx prisma db push --skip-generate', {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    cwd: '/home/ubuntu/.openclaw/workspace/claw-orchestrator',
  });

  prisma = new PrismaClient({ datasourceUrl: dbUrl });
  await prisma.$connect();

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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TC-029: Provision endpoint idempotency → same tenant on duplicate call', () => {
  // ── 1. Add allowlist entry ─────────────────────────────────────────────────

  it('TC-029: POST /v1/admin/allowlist adds U_IDEMPOTENT to allowlist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/allowlist',
      payload: {
        slack_team_id: TEST_TEAM_ID,
        slack_user_id: TEST_USER_ID,
        added_by: 'admin:tc029',
      },
    });

    expect(res.statusCode, `Expected 200, got ${res.statusCode}: ${res.body}`).toBe(200);
    const body = res.json<{ id: string }>();
    expect(body.id).toBeTruthy();
  });

  // ── 2. First provision call ────────────────────────────────────────────────

  it('TC-029: first POST /v1/tenants/provision creates tenant with NEW status', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants/provision',
      payload: { slackTeamId: TEST_TEAM_ID, slackUserId: TEST_USER_ID },
    });

    expect(res.statusCode, `Expected 200, got ${res.statusCode}: ${res.body}`).toBe(200);
    const body = res.json<{ tenantId: string; status: string }>();
    tenantId = body.tenantId;
    expect(tenantId).toBeTruthy();
    expect(body.status).toBe('NEW');

    // Capture data_dir for cleanup
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    tenantDataDir = tenant!.data_dir;
  });

  // ── 3. Second provision call (idempotent) ──────────────────────────────────

  it('TC-029: second POST /v1/tenants/provision returns same tenantId, only 1 DB row, no new audit events', async () => {
    // Count audit events after first provision
    const auditCountBefore = await prisma.auditLog.count({
      where: { tenant_id: tenantId },
    });

    // Second provision call with same principal
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants/provision',
      payload: { slackTeamId: TEST_TEAM_ID, slackUserId: TEST_USER_ID },
    });

    expect(res.statusCode, `Expected 200, got ${res.statusCode}: ${res.body}`).toBe(200);
    const body = res.json<{ tenantId: string; status: string }>();

    // Assert same tenantId returned
    expect(body.tenantId, 'Idempotent call must return same tenantId').toBe(tenantId);

    // Assert only 1 tenant row in DB for this principal
    const tenantRows = await prisma.tenant.findMany({
      where: {
        slack_team_id: TEST_TEAM_ID,
        slack_user_id: TEST_USER_ID,
      },
    });
    expect(tenantRows, 'Only 1 tenant row should exist for this principal').toHaveLength(1);

    // Assert no new audit events written on idempotent call
    const auditCountAfter = await prisma.auditLog.count({
      where: { tenant_id: tenantId },
    });
    expect(
      auditCountAfter,
      `No new audit events should be written on idempotent provision call (before: ${auditCountBefore}, after: ${auditCountAfter})`,
    ).toBe(auditCountBefore);
  });
});

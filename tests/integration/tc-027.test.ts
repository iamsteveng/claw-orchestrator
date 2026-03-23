/**
 * TC-027: Allowlist revocation → existing tenant blocked
 *
 * Verifies that revoking an allowlist entry blocks message delivery for
 * an already-provisioned and active tenant:
 *  1. Add allowlist entry for U_REVOKE
 *  2. Provision and activate tenant for U_REVOKE
 *  3. DELETE /v1/admin/allowlist/:id — assert {revoked: true}
 *  4. POST /v1/tenants/:id/message — assert 403 {ok: false, error: 'Access revoked'}
 *  5. Assert ACCESS_REVOKED audit event written
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';

// ─── Module-level mock timestamp ─────────────────────────────────────────────

let mockNow = 27_000_000;
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

const TEST_TEAM_ID = 'T_TC027';
const TEST_USER_ID = 'U_REVOKE';
const TEST_DATA_DIR = process.env.DATA_DIR!;

// ─── Test State ───────────────────────────────────────────────────────────────

let app: FastifyInstance;
let prisma: PrismaClient;
let tempDbPath: string;
let tenantId: string;
let relayToken: string;
let allowlistId: string;
let tenantDataDir: string;

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  tempDbPath = `/tmp/test-tc027-${randomUUID()}.db`;
  const dbUrl = `file:${tempDbPath}`;

  await mkdir(TEST_DATA_DIR, { recursive: true });

  execSync(`${process.cwd()}/node_modules/.bin/prisma db push --skip-generate`, {
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
      tag: 'claw-tenant:tc027',
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TC-027: Allowlist revocation → existing tenant blocked', () => {
  // ── 1. Add allowlist entry ─────────────────────────────────────────────────

  it('TC-027: POST /v1/admin/allowlist adds U_REVOKE to allowlist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/allowlist',
      payload: {
        slack_team_id: TEST_TEAM_ID,
        slack_user_id: TEST_USER_ID,
        added_by: 'admin:tc027',
      },
    });

    expect(res.statusCode, `Expected 200, got ${res.statusCode}: ${res.body}`).toBe(200);
    const body = res.json<{ id: string; created_at: number }>();
    allowlistId = body.id;
    expect(allowlistId).toBeTruthy();
  });

  // ── 2. Provision tenant ────────────────────────────────────────────────────

  it('TC-027: POST /v1/tenants/provision succeeds for allowlisted U_REVOKE', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants/provision',
      payload: { slackTeamId: TEST_TEAM_ID, slackUserId: TEST_USER_ID },
    });

    expect(res.statusCode, `Expected 200, got ${res.statusCode}: ${res.body}`).toBe(200);
    const body = res.json<{ tenantId: string; status: string; relayToken: string }>();
    tenantId = body.tenantId;
    relayToken = body.relayToken;
    expect(body.status).toBe('NEW');

    // Capture data_dir for cleanup
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    tenantDataDir = tenant!.data_dir;
  });

  // ── 3. Start tenant and wait for ACTIVE ───────────────────────────────────

  it('TC-027: POST /v1/tenants/:id/start activates tenant', async () => {
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

  // ── 4. Revoke allowlist entry ──────────────────────────────────────────────

  it('TC-027: DELETE /v1/admin/allowlist/:id returns {revoked: true}', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/allowlist/${allowlistId}`,
    });

    expect(res.statusCode, `Expected 200, got ${res.statusCode}: ${res.body}`).toBe(200);
    const body = res.json<{ revoked: boolean }>();
    expect(body.revoked).toBe(true);
  });

  // ── 5. Assert revoked_at set in DB ────────────────────────────────────────

  it('TC-027: allowlist entry has revoked_at set after DELETE', async () => {
    const entry = await prisma.allowlist.findUnique({ where: { id: allowlistId } });
    expect(entry).not.toBeNull();
    expect(entry!.revoked_at).not.toBeNull();
    expect(entry!.revoked_at).toBeGreaterThan(0);
  });

  // ── 6. Assert ACCESS_REVOKED audit event ──────────────────────────────────

  it('TC-027: ACCESS_REVOKED audit event written with correct metadata', async () => {
    const audit = await prisma.auditLog.findFirst({
      where: { event_type: 'ACCESS_REVOKED' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actor).toBe('admin');
    expect(audit!.tenant_id).toBeNull();

    const meta = JSON.parse(audit!.metadata ?? '{}') as {
      slack_team_id: string;
      slack_user_id: string;
    };
    expect(meta.slack_team_id).toBe(TEST_TEAM_ID);
    expect(meta.slack_user_id).toBe(TEST_USER_ID);
  });

  // ── 7. Message delivery blocked after revocation ──────────────────────────

  it('TC-027: POST /v1/tenants/:id/message returns 403 {ok: false, error: "Access revoked"} after revocation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/message`,
      headers: { 'x-relay-token': relayToken },
      payload: { slackEventId: 'E_TC027_BLOCKED', text: 'this should be blocked' },
    });

    expect(res.statusCode, `Expected 403, got ${res.statusCode}: ${res.body}`).toBe(403);
    const body = res.json<{ ok: boolean; error: string }>();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('Access revoked');
  });

  // ── 8. No MESSAGE_DELIVERED event for blocked message ────────────────────

  it('TC-027: no MESSAGE_DELIVERED event written for blocked message', async () => {
    const audit = await prisma.auditLog.findFirst({
      where: { tenant_id: tenantId, event_type: 'MESSAGE_DELIVERED' },
    });
    expect(audit).toBeNull();
  });
});

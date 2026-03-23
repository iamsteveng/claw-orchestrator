/**
 * TC-015: Audit log → events recorded for all system actions
 *
 * Verifies that all 8 required audit event types are recorded:
 *  1. TENANT_PROVISIONED — on successful provision
 *  2. TENANT_STARTED     — when container becomes healthy (via pollUntilHealthy)
 *  3. MESSAGE_DELIVERED  — on successful message relay
 *  4. TENANT_STOPPED     — when tenant is stopped
 *  5. TENANT_DELETED     — when tenant is deleted
 *  6. ACCESS_DENIED      — when blocked user attempts provisioning
 *  7. ACCESS_GRANTED     — when allowlist entry is added
 *  8. ACCESS_REVOKED     — when allowlist entry is revoked
 *
 * Also verifies:
 *  - GET /v1/admin/audit returns events in descending created_at order
 *  - No DELETE or UPDATE endpoint exists for audit log (append-only)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';

// ─── Module-level mock timestamp ─────────────────────────────────────────────

// Use small incrementing timestamps to stay within SQLite Int32 range
let mockNow = 15_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Explicit mock docker client — passed directly to buildApp to avoid dynamic import issues
const mockDockerClient = {
  run: vi.fn().mockResolvedValue(undefined),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  inspect: vi.fn().mockResolvedValue(null),
  exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
};

// Also mock the module for any code paths that do dynamic imports
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

// Mock seedWorkspace to succeed without touching the filesystem
vi.mock('../../apps/control-plane/src/seed-workspace.js', () => ({
  seedWorkspace: vi.fn().mockResolvedValue(undefined),
}));

// Mock pollUntilHealthy to simulate a healthy container coming up.
// The mock writes TENANT_STARTED and sets status→ACTIVE, mirroring real behavior.
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

// Import buildApp AFTER vi.mock declarations (vi.mock is hoisted)
import { buildApp } from '../../apps/control-plane/src/app-factory.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_TEAM_ID = 'T_TC015';
const TEST_USER_ID = 'U_TC015';
const BLOCKED_TEAM_ID = 'T_TC015_BLOCKED';
const BLOCKED_USER_ID = 'U_TC015_BLOCKED';

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
  tempDbPath = `/tmp/test-tc015-${randomUUID()}.db`;
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

  // Seed default container image (required by /start endpoint)
  await prisma.containerImage.create({
    data: {
      id: randomUUID(),
      tag: 'claw-tenant:tc015',
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

describe('TC-015: Audit log → events recorded for all system actions', () => {
  // ── 1. ACCESS_DENIED ──────────────────────────────────────────────────────

  it('TC-015: ACCESS_DENIED recorded when blocked user tries to provision', async () => {
    // BLOCKED_TEAM_ID has no allowlist entry → provision returns 403
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants/provision',
      payload: { slackTeamId: BLOCKED_TEAM_ID, slackUserId: BLOCKED_USER_ID },
    });

    expect(res.statusCode).toBe(403);

    const audit = await prisma.auditLog.findFirst({
      where: { event_type: 'ACCESS_DENIED' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actor).toBe('system');
    expect(audit!.tenant_id).toBeNull();
  });

  // ── 2. ACCESS_GRANTED ─────────────────────────────────────────────────────

  it('TC-015: ACCESS_GRANTED recorded when allowlist entry added', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/allowlist',
      payload: {
        slack_team_id: TEST_TEAM_ID,
        slack_user_id: TEST_USER_ID,
        added_by: 'admin:tc015',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; created_at: number }>();
    allowlistId = body.id;
    expect(allowlistId).toBeTruthy();

    const audit = await prisma.auditLog.findFirst({
      where: { event_type: 'ACCESS_GRANTED' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actor).toBe('admin:tc015');
    expect(audit!.tenant_id).toBeNull();
  });

  // ── 3. TENANT_PROVISIONED ─────────────────────────────────────────────────

  it('TC-015: TENANT_PROVISIONED recorded on successful provision', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants/provision',
      payload: { slackTeamId: TEST_TEAM_ID, slackUserId: TEST_USER_ID },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ tenantId: string; status: string; relayToken: string }>();
    tenantId = body.tenantId;
    relayToken = body.relayToken;
    expect(body.status).toBe('NEW');

    // Capture data_dir for cleanup
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    tenantDataDir = tenant!.data_dir;

    const audit = await prisma.auditLog.findFirst({
      where: { tenant_id: tenantId, event_type: 'TENANT_PROVISIONED' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actor).toBe('system');
  });

  // ── 4. TENANT_STARTED ─────────────────────────────────────────────────────

  it('TC-015: TENANT_STARTED recorded when tenant starts (via pollUntilHealthy)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/start`,
    });

    // Start returns 202 (starting) or 200 (already active)
    expect(
      res.statusCode,
      `Start returned ${res.statusCode}: ${res.body}`,
    ).toSatisfy((s: number) => s === 200 || s === 202);

    // pollUntilHealthy mock is async — flush microtask queue (multiple passes needed
    // because Prisma awaits chain: tenant.update → auditLog.create → each needs a turn)
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const audit = await prisma.auditLog.findFirst({
      where: { tenant_id: tenantId, event_type: 'TENANT_STARTED' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actor).toBe('system');

    // Tenant status should now be ACTIVE
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant!.status).toBe('ACTIVE');
  });

  // ── 5. MESSAGE_DELIVERED ──────────────────────────────────────────────────

  it('TC-015: MESSAGE_DELIVERED recorded on successful message delivery', async () => {
    // Mock global fetch to simulate container returning a successful response
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: 'handled' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/message`,
      headers: { 'x-relay-token': relayToken },
      payload: { slackEventId: 'E_TC015_MSG1', text: 'hello from tc-015' },
    });

    fetchSpy.mockRestore();

    expect(res.statusCode).toBe(200);

    const audit = await prisma.auditLog.findFirst({
      where: { tenant_id: tenantId, event_type: 'MESSAGE_DELIVERED' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actor).toBe('system');
    const meta = JSON.parse(audit!.metadata ?? '{}') as { slackEventId: string };
    expect(meta.slackEventId).toBe('E_TC015_MSG1');
  });

  // ── 6. TENANT_STOPPED ────────────────────────────────────────────────────

  it('TC-015: TENANT_STOPPED recorded when tenant stopped', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/stop`,
      payload: { actor: 'system' },
    });

    expect(res.statusCode).toBe(200);

    const audit = await prisma.auditLog.findFirst({
      where: { tenant_id: tenantId, event_type: 'TENANT_STOPPED' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actor).toBe('system');
  });

  // ── 7. TENANT_DELETED ────────────────────────────────────────────────────

  it('TC-015: TENANT_DELETED recorded when tenant deleted', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/${tenantId}`,
    });

    expect(res.statusCode).toBe(200);

    const audit = await prisma.auditLog.findFirst({
      where: { tenant_id: tenantId, event_type: 'TENANT_DELETED' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actor).toBe('admin');
  });

  // ── 8. ACCESS_REVOKED ────────────────────────────────────────────────────

  it('TC-015: ACCESS_REVOKED recorded when allowlist entry revoked', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/allowlist/${allowlistId}`,
    });

    expect(res.statusCode).toBe(200);

    const audit = await prisma.auditLog.findFirst({
      where: { event_type: 'ACCESS_REVOKED' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actor).toBe('admin');
    expect(audit!.tenant_id).toBeNull();
  });

  // ── Audit API: all 8 event types present globally ────────────────────────

  it('TC-015: GET /v1/admin/audit returns all 8 event types', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      events: Array<{ event_type: string; created_at: number }>;
      total: number;
    }>();

    expect(body.total).toBeGreaterThanOrEqual(8);

    const eventTypes = new Set(body.events.map((e) => e.event_type));
    expect(eventTypes.has('TENANT_PROVISIONED')).toBe(true);
    expect(eventTypes.has('TENANT_STARTED')).toBe(true);
    expect(eventTypes.has('MESSAGE_DELIVERED')).toBe(true);
    expect(eventTypes.has('TENANT_STOPPED')).toBe(true);
    expect(eventTypes.has('TENANT_DELETED')).toBe(true);
    expect(eventTypes.has('ACCESS_DENIED')).toBe(true);
    expect(eventTypes.has('ACCESS_GRANTED')).toBe(true);
    expect(eventTypes.has('ACCESS_REVOKED')).toBe(true);
  });

  // ── Audit API: descending order ───────────────────────────────────────────

  it('TC-015: GET /v1/admin/audit?tenant_id=X returns events in descending order', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/audit?tenant_id=${tenantId}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      events: Array<{ event_type: string; created_at: number }>;
      total: number;
    }>();

    // Tenant-specific events: PROVISIONED, STARTED, MESSAGE_DELIVERED, STOPPED, DELETED
    expect(body.total).toBeGreaterThanOrEqual(5);

    // Verify descending order
    for (let i = 1; i < body.events.length; i++) {
      expect(body.events[i - 1].created_at).toBeGreaterThanOrEqual(body.events[i].created_at);
    }
  });

  // ── Append-only: no DELETE/UPDATE endpoints ───────────────────────────────

  it('TC-015: no DELETE endpoint exists for audit log (append-only)', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/v1/admin/audit' });
    expect(res.statusCode).toBe(404);
  });

  it('TC-015: no PUT endpoint exists for audit log (append-only)', async () => {
    const res = await app.inject({ method: 'PUT', url: '/v1/admin/audit' });
    expect(res.statusCode).toBe(404);
  });

  it('TC-015: no PATCH endpoint exists for audit log (append-only)', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/v1/admin/audit' });
    expect(res.statusCode).toBe(404);
  });
});

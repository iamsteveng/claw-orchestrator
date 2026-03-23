/**
 * TC-032: Message forwarding → disk quota exceeded → 507
 *
 * Verifies that the /v1/tenants/:id/message endpoint enforces disk quota:
 *  1. Provision and activate tenant
 *  2. Set tenant.disk_quota_exceeded = 1 directly in DB
 *  3. POST /v1/tenants/:id/message with correct relay token → 507 {ok:false, error:'Disk quota exceeded'}
 *  4. Set disk_quota_exceeded = 0
 *  5. POST /v1/tenants/:id/message again → 200 (message forwarded)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';

// ─── Module-level mock timestamp ─────────────────────────────────────────────

let mockNow = 32_000_000;
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

const TEST_TEAM_ID = 'T_TC032';
const TEST_USER_ID = 'U_TC032';
const TEST_DATA_DIR = process.env.DATA_DIR!;

// ─── Test State ───────────────────────────────────────────────────────────────

let app: FastifyInstance;
let prisma: PrismaClient;
let tempDbPath: string;
let tenantId: string;
let relayToken: string;
let tenantDataDir: string;

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  tempDbPath = `/tmp/test-tc032-${randomUUID()}.db`;
  const dbUrl = `file:${tempDbPath}`;

  await mkdir(TEST_DATA_DIR, { recursive: true });

  const result = spawnSync(`${process.cwd()}/node_modules/.bin/prisma`, ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    shell: false,
    cwd: process.cwd(),
  });
  if (result.status !== 0) throw new Error('prisma db push failed: ' + String(result.stderr ?? result.stdout ?? 'unknown error'));

  prisma = new PrismaClient({ datasourceUrl: dbUrl });
  await prisma.$connect();

  // Seed default container image (required by /start endpoint)
  await prisma.containerImage.create({
    data: {
      id: randomUUID(),
      tag: 'claw-tenant:tc032',
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

  if (tenantDataDir) {
    try {
      await rm(tenantDataDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }

  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(tempDbPath);
  } catch { /* best-effort */ }
}, 30_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TC-032: Message forwarding → disk quota exceeded → 507', () => {
  // ── 1. Add allowlist entry ─────────────────────────────────────────────────

  it('TC-032: POST /v1/admin/allowlist adds U_TC032 to allowlist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/allowlist',
      payload: {
        slack_team_id: TEST_TEAM_ID,
        slack_user_id: TEST_USER_ID,
        added_by: 'admin:tc032',
      },
    });

    expect(res.statusCode, `Expected 200, got ${res.statusCode}: ${res.body}`).toBe(200);
    const body = res.json<{ id: string; created_at: number }>();
    expect(body.id).toBeTruthy();
  });

  // ── 2. Provision tenant ────────────────────────────────────────────────────

  it('TC-032: POST /v1/tenants/provision returns tenantId and relayToken', async () => {
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
    expect(relayToken).toBeTruthy();

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    tenantDataDir = tenant!.data_dir;
  });

  // ── 3. Start tenant and wait for ACTIVE ───────────────────────────────────

  it('TC-032: POST /v1/tenants/:id/start activates tenant', async () => {
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
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant!.status, 'Tenant should be ACTIVE after start').toBe('ACTIVE');
  });

  // ── 4. Set disk_quota_exceeded = 1 ────────────────────────────────────────

  it('TC-032: Set disk_quota_exceeded = 1 directly in DB', async () => {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { disk_quota_exceeded: 1, updated_at: mockNow++ },
    });

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant!.disk_quota_exceeded).toBe(1);
  });

  // ── 5. Message with disk_quota_exceeded=1 → 507 ──────────────────────────

  it('TC-032: POST /v1/tenants/:id/message returns 507 {ok:false, error:"Disk quota exceeded"} when disk_quota_exceeded=1', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/message`,
      headers: { 'x-relay-token': relayToken },
      payload: { slackEventId: 'E_TC032_QUOTA', text: 'should be blocked by quota' },
    });

    expect(res.statusCode, `Expected 507, got ${res.statusCode}: ${res.body}`).toBe(507);
    const body = res.json<{ ok: boolean; error: string }>();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('Disk quota exceeded');
  });

  // ── 6. No MESSAGE_DELIVERED event written for quota-blocked messages ──────

  it('TC-032: no MESSAGE_DELIVERED event written when blocked by disk quota', async () => {
    const audit = await prisma.auditLog.findFirst({
      where: { tenant_id: tenantId, event_type: 'MESSAGE_DELIVERED' },
    });
    expect(audit, 'No MESSAGE_DELIVERED should exist while disk_quota_exceeded=1').toBeNull();
  });

  // ── 7. Clear disk_quota_exceeded = 0 ─────────────────────────────────────

  it('TC-032: Set disk_quota_exceeded = 0 directly in DB', async () => {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { disk_quota_exceeded: 0, updated_at: mockNow++ },
    });

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant!.disk_quota_exceeded).toBe(0);
  });

  // ── 8. Message with disk_quota_exceeded=0 → 200 (forwarded) ──────────────

  it('TC-032: POST /v1/tenants/:id/message returns 200 after disk_quota_exceeded cleared', async () => {
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
      payload: { slackEventId: 'E_TC032_OK', text: 'quota cleared, should forward' },
    });

    fetchSpy.mockRestore();

    expect(res.statusCode, `Expected 200, got ${res.statusCode}: ${res.body}`).toBe(200);
    const body = res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
  });

  // ── 9. MESSAGE_DELIVERED audit event written after quota cleared ──────────

  it('TC-032: MESSAGE_DELIVERED audit event written after quota cleared and message delivered', async () => {
    const audit = await prisma.auditLog.findFirst({
      where: { tenant_id: tenantId, event_type: 'MESSAGE_DELIVERED' },
    });
    expect(audit, 'MESSAGE_DELIVERED should be written after quota cleared').not.toBeNull();
    expect(audit!.actor).toBe('system');
    const meta = JSON.parse(audit!.metadata ?? '{}') as { slackEventId: string };
    expect(meta.slackEventId).toBe('E_TC032_OK');
  });
});

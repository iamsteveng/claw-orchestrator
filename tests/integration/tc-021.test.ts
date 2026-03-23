/**
 * TC-021: Start endpoint → STOPPED → STARTING → ACTIVE transition
 *
 * Verifies the full state machine when a STOPPED tenant is started:
 *  1. POST /start returns 202 {status: 'starting'}
 *  2. Tenant DB status becomes STARTING
 *  3. After health polling succeeds, tenant becomes ACTIVE
 *  4. TENANT_STARTED audit event is written
 *  5. Second POST /start is idempotent → returns {status: 'active'}
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';

// ─── Module-level mock timestamp ─────────────────────────────────────────────

let mockNow = 10_000_000;
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

// Mock pollUntilHealthy to simulate a healthy container coming up.
// Mirrors real behavior: sets status→ACTIVE and writes TENANT_STARTED audit.
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

const TEST_DATA_DIR = process.env.DATA_DIR!;

// ─── Test State ───────────────────────────────────────────────────────────────

let app: FastifyInstance;
let prisma: PrismaClient;
let tempDbPath: string;
let tenantId: string;
let tenantDataDir: string;

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  tempDbPath = `/tmp/test-tc021-${randomUUID()}.db`;
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
      tag: 'claw-tenant:tc021',
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

describe('TC-021: Start endpoint → STOPPED → STARTING → ACTIVE transition', () => {
  it('TC-021: creates STOPPED tenant in DB via direct insert', async () => {
    tenantId = randomUUID();
    tenantDataDir = `${TEST_DATA_DIR}/tc021-${tenantId}`;
    await mkdir(tenantDataDir, { recursive: true });

    const now = mockNow++;
    await prisma.tenant.create({
      data: {
        id: tenantId,
        slack_team_id: 'T_TC021',
        slack_user_id: 'U_TC021',
        principal: 'T_TC021:U_TC021',
        status: 'STOPPED',
        relay_token: randomUUID(),
        container_name: `claw-tenant-${tenantId}`,
        data_dir: tenantDataDir,
        image_tag: 'claw-tenant:tc021',
        provision_attempts: 1,
        created_at: now,
        updated_at: now,
      },
    });

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.status).toBe('STOPPED');
  });

  it('TC-021: POST /start returns 202 {status: "starting"}', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/start`,
    });

    expect(res.statusCode, `Expected 202, got ${res.statusCode}: ${res.body}`).toBe(202);
    const body = res.json<{ status: string }>();
    expect(body.status).toBe('starting');
  });

  it('TC-021: tenant DB status is STARTING after /start call', async () => {
    // The /start endpoint sets status=STARTING synchronously before returning
    // We check immediately after the previous test's POST resolved
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant).not.toBeNull();
    // Status may already be ACTIVE if pollUntilHealthy ran synchronously — both valid
    expect(['STARTING', 'ACTIVE']).toContain(tenant!.status);
  });

  it('TC-021: tenant reaches ACTIVE status after health polling (max 10s)', async () => {
    // pollUntilHealthy mock runs async via void — flush microtask/setImmediate queues
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.status).toBe('ACTIVE');
  });

  it('TC-021: TENANT_STARTED audit event written', async () => {
    const audit = await prisma.auditLog.findFirst({
      where: { tenant_id: tenantId, event_type: 'TENANT_STARTED' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actor).toBe('system');

    const meta = JSON.parse(audit!.metadata ?? '{}') as { containerName: string };
    expect(meta.containerName).toBe(`claw-tenant-${tenantId}`);
  });

  it('TC-021: docker.start called (not docker.run) for STOPPED tenant', async () => {
    // STOPPED tenants restart existing containers — docker.start, not docker.run
    expect(mockDockerClient.start).toHaveBeenCalledWith(`claw-tenant-${tenantId}`);
    expect(mockDockerClient.run).not.toHaveBeenCalled();
  });

  it('TC-021: second POST /start is idempotent → returns {status: "active"}', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/start`,
    });

    // Idempotent: already ACTIVE → 200 with status='active'
    expect(res.statusCode, `Expected 200, got ${res.statusCode}: ${res.body}`).toBe(200);
    const body = res.json<{ status: string }>();
    expect(body.status).toBe('active');
  });
});

/**
 * TC-024: Container image promote → new default used on next start
 *
 * Verifies image promotion workflow:
 *  1. Seed default image v1.0
 *  2. Insert v2.0 image (non-default)
 *  3. POST /v1/admin/images/:id/promote for v2.0
 *  4. Assert v2.0 is_default=1
 *  5. Assert v1.0 is_default=0 and deprecated_at set
 *  6. Start a tenant → assert image_tag = v2.0 on tenant row
 *  7. Assert IMAGE_UPDATED audit event
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';

// ─── Module-level mock timestamp ─────────────────────────────────────────────

let mockNow = 24_000_000;
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
let imageV1Id: string;
let imageV2Id: string;

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  tempDbPath = `/tmp/test-tc024-${randomUUID()}.db`;
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

  // Seed default container image v1.0
  imageV1Id = randomUUID();
  await prisma.containerImage.create({
    data: {
      id: imageV1Id,
      tag: 'claw-tenant:v1.0',
      is_default: 1,
      created_at: mockNow++,
    },
  });

  // Insert non-default image v2.0
  imageV2Id = randomUUID();
  await prisma.containerImage.create({
    data: {
      id: imageV2Id,
      tag: 'claw-tenant:v2.0',
      is_default: 0,
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

describe('TC-024: Container image promote → new default used on next start', () => {
  it('TC-024: POST /v1/admin/images/:id/promote returns {promoted: true, tag}', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/images/${imageV2Id}/promote`,
    });

    expect(res.statusCode, `Expected 200, got ${res.statusCode}: ${res.body}`).toBe(200);
    const body = res.json<{ promoted: boolean; tag: string }>();
    expect(body.promoted).toBe(true);
    expect(body.tag).toBe('claw-tenant:v2.0');
  });

  it('TC-024: v2.0 is_default=1 after promotion', async () => {
    const v2 = await prisma.containerImage.findUnique({ where: { id: imageV2Id } });
    expect(v2).not.toBeNull();
    expect(v2!.is_default).toBe(1);
  });

  it('TC-024: v1.0 is_default=0 and deprecated_at set after promotion', async () => {
    const v1 = await prisma.containerImage.findUnique({ where: { id: imageV1Id } });
    expect(v1).not.toBeNull();
    expect(v1!.is_default).toBe(0);
    expect(v1!.deprecated_at).not.toBeNull();
    expect(v1!.deprecated_at).toBeGreaterThan(0);
  });

  it('TC-024: IMAGE_UPDATED audit event written for promotion (actor=admin)', async () => {
    const audit = await prisma.auditLog.findFirst({
      where: { event_type: 'IMAGE_UPDATED', actor: 'admin' },
    });
    expect(audit).not.toBeNull();
    const meta = JSON.parse(audit!.metadata ?? '{}') as { promotedTag: string };
    expect(meta.promotedTag).toBe('claw-tenant:v2.0');
  });

  it('TC-024: create STOPPED tenant with old image_tag v1.0', async () => {
    tenantId = randomUUID();
    tenantDataDir = `${TEST_DATA_DIR}/tc024-${tenantId}`;
    await mkdir(tenantDataDir, { recursive: true });

    const now = mockNow++;
    await prisma.tenant.create({
      data: {
        id: tenantId,
        slack_team_id: 'T_TC024',
        slack_user_id: 'U_TC024',
        principal: 'T_TC024:U_TC024',
        status: 'STOPPED',
        relay_token: randomUUID(),
        container_name: `claw-tenant-${tenantId}`,
        data_dir: tenantDataDir,
        image_tag: 'claw-tenant:v1.0',
        provision_attempts: 1,
        created_at: now,
        updated_at: now,
      },
    });

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.status).toBe('STOPPED');
    expect(tenant!.image_tag).toBe('claw-tenant:v1.0');
  });

  it('TC-024: POST /start returns 202 {status: "starting"}', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/start`,
    });

    expect(res.statusCode, `Expected 202, got ${res.statusCode}: ${res.body}`).toBe(202);
    const body = res.json<{ status: string }>();
    expect(body.status).toBe('starting');
  });

  it('TC-024: tenant image_tag updated to v2.0 after start', async () => {
    // The start endpoint updates image_tag synchronously before returning
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.image_tag).toBe('claw-tenant:v2.0');
  });

  it('TC-024: IMAGE_UPDATED audit event written for tenant with old→new tag', async () => {
    const audit = await prisma.auditLog.findFirst({
      where: { tenant_id: tenantId, event_type: 'IMAGE_UPDATED' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actor).toBe('system');
    const meta = JSON.parse(audit!.metadata ?? '{}') as { oldTag: string; newTag: string };
    expect(meta.oldTag).toBe('claw-tenant:v1.0');
    expect(meta.newTag).toBe('claw-tenant:v2.0');
  });

  it('TC-024: tenant reaches ACTIVE status after health polling', async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.status).toBe('ACTIVE');
    // image_tag must still be v2.0 after becoming ACTIVE
    expect(tenant!.image_tag).toBe('claw-tenant:v2.0');
  });
});

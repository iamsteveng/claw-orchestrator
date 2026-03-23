/**
 * TC-007: Tenant deletion → data cleaned up
 *
 * Verifies that DELETE /v1/tenants/:id:
 *  - Returns { deleted: true }
 *  - Soft-deletes the tenant row (deleted_at set)
 *  - Purges all message_queue rows for the tenant
 *  - Purges startup_locks row for the tenant
 *  - Writes a TENANT_DELETED audit log entry
 *  - Moves the tenant data_dir to an archive location
 *  - Returns HTTP 409 on a second DELETE attempt
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, access } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';

// Mock docker-client before any imports that use it (vi.mock is hoisted)
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

// Mock Date.now() to avoid SQLite Int32 overflow (real epoch ms is ~13 digits)
let mockNow = 9_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);

// Import buildApp AFTER vi.mock declarations (vi.mock is hoisted, spyOn is not)
import { buildApp } from '../../apps/control-plane/src/app-factory.js';

let app: FastifyInstance;
let prisma: PrismaClient;
let tempDbPath: string;

// DATA_DIR is set by vitest-setup.ts to /tmp/claw-test-tenants
const TEST_DATA_DIR = process.env.DATA_DIR!;

const TEST_TEAM_ID = 'T_TC007_TEAM';
const TEST_USER_ID = 'U_TC007_USER';

beforeAll(async () => {
  // Create isolated temp SQLite DB
  const dbId = randomUUID();
  tempDbPath = `/tmp/test-tc007-${dbId}.db`;
  const dbUrl = `file:${tempDbPath}`;

  // Ensure test data dir exists
  await mkdir(TEST_DATA_DIR, { recursive: true });

  // Apply Prisma schema to temp DB
  const result = spawnSync(`${process.cwd()}/node_modules/.bin/prisma`, ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    shell: false,
  });
  if (result.status !== 0) throw new Error('prisma db push failed: ' + String(result.stderr ?? result.stdout ?? 'unknown error'));

  // Create PrismaClient pointing at test DB
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

  // Seed allowlist entry for TC-007 team
  await prisma.allowlist.create({
    data: {
      id: randomUUID(),
      slack_team_id: TEST_TEAM_ID,
      slack_user_id: null,
      added_by: 'tc-007-setup',
      created_at: mockNow++,
    },
  });

  // Build control-plane app with the test prisma instance
  app = await buildApp(prisma, { logger: false });
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  if (prisma) await prisma.$disconnect();

  // Remove temp DB (best-effort)
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(tempDbPath);
  } catch {
    // best-effort
  }
});

describe('TC-007: Tenant deletion → data cleaned up', () => {
  it('TC-007: cleans up all tenant resources on DELETE and returns 409 on second attempt', async () => {
    // ── Step 1: Provision the tenant ──────────────────────────────────────────
    const provisionRes = await app.inject({
      method: 'POST',
      url: '/v1/tenants/provision',
      payload: {
        slackTeamId: TEST_TEAM_ID,
        slackUserId: TEST_USER_ID,
      },
    });

    expect(provisionRes.statusCode).toBe(200);
    const { tenantId } = provisionRes.json<{ tenantId: string; status: string }>();
    expect(tenantId).toBeTruthy();

    // ── Step 2: Verify tenant dir was created ─────────────────────────────────
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant).not.toBeNull();
    const dataDir = tenant!.data_dir;

    // Confirm data dir exists on disk
    await expect(access(dataDir)).resolves.toBeUndefined();

    // ── Step 3: Seed message_queue rows for this tenant ───────────────────────
    await prisma.messageQueue.create({
      data: {
        id: randomUUID(),
        tenant_id: tenantId,
        slack_event_id: `Ev_TC007_${randomUUID().slice(0, 8)}`,
        payload: JSON.stringify({ text: 'hello', userId: TEST_USER_ID, teamId: TEST_TEAM_ID }),
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
        slack_event_id: `Ev_TC007_${randomUUID().slice(0, 8)}`,
        payload: JSON.stringify({ text: 'world', userId: TEST_USER_ID, teamId: TEST_TEAM_ID }),
        status: 'PENDING',
        attempts: 0,
        created_at: mockNow++,
        updated_at: mockNow++,
      },
    });

    // Verify queue rows were created
    const queueBefore = await prisma.messageQueue.count({ where: { tenant_id: tenantId } });
    expect(queueBefore).toBe(2);

    // ── Step 4: Seed a startup_lock row ───────────────────────────────────────
    await prisma.startupLock.create({
      data: {
        tenant_id: tenantId,
        locked_by: randomUUID(),
        acquired_at: mockNow++,
        expires_at: mockNow + 60_000,
      },
    });

    const lockBefore = await prisma.startupLock.count({ where: { tenant_id: tenantId } });
    expect(lockBefore).toBe(1);

    // ── Step 5: Call DELETE /v1/tenants/:id ───────────────────────────────────
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/${tenantId}`,
    });

    expect(deleteRes.statusCode).toBe(200);
    const deleteBody = deleteRes.json<{ deleted: boolean }>();
    expect(deleteBody.deleted).toBe(true);

    // ── Step 6: Assert tenant row has deleted_at set (soft delete) ────────────
    const deletedTenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(deletedTenant).not.toBeNull();
    expect(deletedTenant!.deleted_at).not.toBeNull();
    expect(typeof deletedTenant!.deleted_at).toBe('bigint');

    // ── Step 7: Assert message_queue rows purged ──────────────────────────────
    const queueAfter = await prisma.messageQueue.count({ where: { tenant_id: tenantId } });
    expect(queueAfter).toBe(0);

    // ── Step 8: Assert startup_lock purged ────────────────────────────────────
    const lockAfter = await prisma.startupLock.count({ where: { tenant_id: tenantId } });
    expect(lockAfter).toBe(0);

    // ── Step 9: Assert TENANT_DELETED audit log entry ─────────────────────────
    const auditLog = await prisma.auditLog.findFirst({
      where: {
        tenant_id: tenantId,
        event_type: 'TENANT_DELETED',
      },
    });
    expect(auditLog).not.toBeNull();
    expect(auditLog!.actor).toBe('admin');

    // ── Step 10: Assert tenant data_dir moved to archive ─────────────────────
    // Original dir should no longer exist
    await expect(access(dataDir)).rejects.toThrow();

    // archiveDir is stored in the audit log metadata
    const metadata = JSON.parse(auditLog!.metadata ?? '{}') as { archiveDir?: string };
    expect(metadata.archiveDir).toBeTruthy();
    const archiveDir = metadata.archiveDir!;

    // Archive dir should exist
    await expect(access(archiveDir)).resolves.toBeUndefined();

    // ── Step 11: Assert second DELETE returns HTTP 409 ────────────────────────
    const secondDeleteRes = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/${tenantId}`,
    });

    expect(secondDeleteRes.statusCode).toBe(409);

    // Cleanup archive dir (best-effort, only this test's artifact)
    try {
      await rm(archiveDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });
});

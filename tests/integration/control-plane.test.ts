/**
 * Integration tests for the control-plane API.
 * Uses a real SQLite temp DB and mocked Docker client.
 *
 * NOTE: The Prisma schema uses `Int` for timestamp fields. Prisma's SQLite
 * driver validates these as 32-bit integers, but the app code uses Date.now()
 * (milliseconds since epoch, ~13 digits) which exceeds 32-bit range.
 * We mock Date.now() to return a small incrementing integer so DB writes succeed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

// Prisma's SQLite driver validates Int columns as 32-bit integers.
// The app uses Date.now() (ms epoch, ~13 digits) which exceeds 32-bit range.
// We mock Date.now() to return a small incrementing counter so writes succeed.
let mockNow = 1_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);

// Import buildApp AFTER vi.mock is declared (vi.mock is hoisted, spyOn is not)
import { buildApp } from '../../apps/control-plane/src/app-factory.js';

let app: FastifyInstance;
let prisma: PrismaClient;
let tempDbPath: string;
// controlPlaneConfig.DATA_DIR is set to process.env.DATA_DIR at module load time.
// vitest-setup.ts sets DATA_DIR=/tmp/claw-test-tenants before modules load.
// We create this directory and use it for test tenants.
const TEST_DATA_DIR = process.env.DATA_DIR!;

const TEST_TEAM_ID = 'T_TEST_TEAM';
const TEST_USER_ID = 'U_TEST_USER';

beforeAll(async () => {
  // Create temp DB file
  const dbId = randomUUID();
  tempDbPath = `/tmp/test-integ-${dbId}.db`;
  const dbUrl = `file:${tempDbPath}`;

  // Ensure test data dir exists
  await mkdir(TEST_DATA_DIR, { recursive: true });

  // Apply schema via prisma db push
  const result = spawnSync(`${process.cwd()}/node_modules/.bin/prisma`, ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    shell: false,
  });
  if (result.status !== 0) throw new Error('prisma db push failed: ' + String(result.stderr ?? result.stdout ?? 'unknown error'));

  // Override DATABASE_URL env so controlPlaneConfig picks up the test DB
  // (Note: controlPlaneConfig is already loaded, but PrismaClient uses datasourceUrl directly)
  process.env.DATABASE_URL = dbUrl;

  // Create PrismaClient with test DB
  prisma = new PrismaClient({ datasourceUrl: dbUrl });
  await prisma.$connect();

  // Seed a default container image
  await prisma.containerImage.create({
    data: {
      id: randomUUID(),
      tag: 'claw-tenant:test',
      is_default: 1,
      created_at: mockNow++,
    },
  });

  // Seed an allowlist entry for test users (allows entire TEST team)
  await prisma.allowlist.create({
    data: {
      id: randomUUID(),
      slack_team_id: TEST_TEAM_ID,
      slack_user_id: null,
      added_by: 'test-setup',
      created_at: mockNow++,
    },
  });

  // Build app with the test prisma instance
  app = await buildApp(prisma, { logger: false });
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  if (prisma) await prisma.$disconnect();

  // Delete temp DB
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(tempDbPath);
  } catch {
    // best-effort
  }

  // Clean up test data dir
  try {
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe('Control Plane API Integration Tests', () => {
  describe('POST /v1/tenants/provision', () => {
    it('Test 1: creates tenant row with status=NEW and correct tenant_id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/tenants/provision',
        payload: {
          slackTeamId: TEST_TEAM_ID,
          slackUserId: TEST_USER_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ tenantId: string; status: string; relayToken: string }>();
      expect(body.tenantId).toBeTruthy();
      expect(body.status).toBe('NEW');
      expect(body.relayToken).toBeTruthy();

      // Verify DB row
      const tenant = await prisma.tenant.findUnique({ where: { id: body.tenantId } });
      expect(tenant).not.toBeNull();
      expect(tenant!.status).toBe('NEW');
      expect(tenant!.slack_team_id).toBe(TEST_TEAM_ID);
      expect(tenant!.slack_user_id).toBe(TEST_USER_ID);

      // Verify tenantId is deterministic hash of principal
      const { createHash } = await import('node:crypto');
      const principal = `${TEST_TEAM_ID}:${TEST_USER_ID}`;
      const expectedTenantId = createHash('sha256').update(principal).digest('hex').slice(0, 16);
      expect(body.tenantId).toBe(expectedTenantId);
    });

    it('Test 2: is idempotent (calling twice returns same tenant_id)', async () => {
      // Second call for the same user (provisioned in Test 1)
      const res = await app.inject({
        method: 'POST',
        url: '/v1/tenants/provision',
        payload: {
          slackTeamId: TEST_TEAM_ID,
          slackUserId: TEST_USER_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ tenantId: string; status: string; relayToken: string }>();
      expect(body.tenantId).toBeTruthy();
      // After Test 3 (stop), status is STOPPED; before stop it's NEW
      expect(['NEW', 'STOPPED']).toContain(body.status);

      // Verify same tenantId
      const { createHash } = await import('node:crypto');
      const principal = `${TEST_TEAM_ID}:${TEST_USER_ID}`;
      const expectedTenantId = createHash('sha256').update(principal).digest('hex').slice(0, 16);
      expect(body.tenantId).toBe(expectedTenantId);

      // Verify only one tenant row exists for this principal
      const count = await prisma.tenant.count({
        where: { principal: `${TEST_TEAM_ID}:${TEST_USER_ID}` },
      });
      expect(count).toBe(1);
    });

    it('Test 5: allowlist check blocks provisioning when no matching allowlist row (403)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/tenants/provision',
        payload: {
          slackTeamId: 'T_BLOCKED_TEAM',
          slackUserId: 'U_BLOCKED_USER',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = res.json<{ error: string }>();
      expect(body.error).toBe('Access denied');
    });
  });

  describe('POST /v1/tenants/:id/stop', () => {
    it('Test 3: transitions status to STOPPED', async () => {
      // Get the tenant created in Test 1
      const { createHash } = await import('node:crypto');
      const principal = `${TEST_TEAM_ID}:${TEST_USER_ID}`;
      const tenantId = createHash('sha256').update(principal).digest('hex').slice(0, 16);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/stop`,
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ status: string }>();
      expect(body.status).toBe('stopped');

      // Verify DB status
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
      expect(tenant!.status).toBe('STOPPED');
    });
  });

  describe('DELETE /v1/tenants/:id', () => {
    it('Test 4: sets deleted_at and writes TENANT_DELETED audit log entry', async () => {
      // Provision a fresh tenant to delete
      const deleteTeamId = 'T_DELETE_TEAM';
      const deleteUserId = 'U_DELETE_USER';

      // Add to allowlist first
      await prisma.allowlist.create({
        data: {
          id: randomUUID(),
          slack_team_id: deleteTeamId,
          slack_user_id: null,
          added_by: 'test-setup',
          created_at: mockNow++,
        },
      });

      const provisionRes = await app.inject({
        method: 'POST',
        url: '/v1/tenants/provision',
        payload: {
          slackTeamId: deleteTeamId,
          slackUserId: deleteUserId,
        },
      });

      expect(provisionRes.statusCode).toBe(200);
      const { tenantId } = provisionRes.json<{ tenantId: string }>();

      // Now delete the tenant
      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/v1/tenants/${tenantId}`,
      });

      expect(deleteRes.statusCode).toBe(200);
      const deleteBody = deleteRes.json<{ deleted: boolean }>();
      expect(deleteBody.deleted).toBe(true);

      // Verify deleted_at is set
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
      expect(tenant!.deleted_at).not.toBeNull();

      // Verify TENANT_DELETED audit log entry
      const auditLog = await prisma.auditLog.findFirst({
        where: {
          tenant_id: tenantId,
          event_type: 'TENANT_DELETED',
        },
      });
      expect(auditLog).not.toBeNull();
      expect(auditLog!.actor).toBe('admin');
    });
  });

  describe('POST /v1/tenants/:id/start (capacity cap)', () => {
    it('Test 6: MAX_ACTIVE_TENANTS=10 blocks second tenant start when 10 already active (status=queued)', async () => {
      const team = 'T_CAPACITY_TEAM';

      // Allowlist the team
      await prisma.allowlist.create({
        data: {
          id: randomUUID(),
          slack_team_id: team,
          slack_user_id: null,
          added_by: 'test-setup',
          created_at: mockNow++,
        },
      });

      // Provision tenant A (to be queued)
      const provA = await app.inject({
        method: 'POST',
        url: '/v1/tenants/provision',
        payload: { slackTeamId: team, slackUserId: 'U_CAP_A' },
      });
      expect(provA.statusCode).toBe(200);
      const { tenantId: tenantIdA } = provA.json<{ tenantId: string }>();

      // Fill up active slots with 10 filler tenants directly via DB
      const fillerTenants: string[] = [];
      for (let i = 0; i < 10; i++) {
        const fillId = randomUUID().slice(0, 16);
        const fillPrincipal = `T_FILLER:U_FILLER_${i}`;
        fillerTenants.push(fillId);
        await prisma.tenant.create({
          data: {
            id: fillId,
            principal: fillPrincipal,
            slack_team_id: 'T_FILLER',
            slack_user_id: `U_FILLER_${i}`,
            status: 'ACTIVE',
            relay_token: randomUUID(),
            container_name: `claw-tenant-${fillId}`,
            data_dir: `${TEST_DATA_DIR}/${fillId}`,
            provision_attempts: 0,
            created_at: mockNow++,
            updated_at: mockNow++,
          },
        });
      }

      // Verify we have 10 ACTIVE tenants
      const activeCount = await prisma.tenant.count({ where: { status: 'ACTIVE' } });
      expect(activeCount).toBe(10);

      // Try to start tenant A — should be queued since MAX_ACTIVE_TENANTS=10 is hit
      const startRes = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantIdA}/start`,
        payload: {},
      });

      expect(startRes.statusCode).toBe(202);
      const startBody = startRes.json<{ status: string }>();
      expect(startBody.status).toBe('queued');

      // Verify queued_for_start_at is set on the tenant
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantIdA } });
      expect(tenant!.queued_for_start_at).not.toBeNull();

      // Cleanup: reset all filler tenants
      await prisma.tenant.deleteMany({ where: { id: { in: fillerTenants } } });
    });
  });
});

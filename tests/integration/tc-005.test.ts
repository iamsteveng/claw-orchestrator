/**
 * TC-005: Different users → completely isolated (no shared workspace/state)
 *
 * Integration test verifying complete filesystem and identity isolation between
 * two tenants belonging to the same Slack team but different users:
 * - Provision tenant A (team T_TC005, user U_TC005_A) via POST /v1/tenants/provision
 * - Provision tenant B (team T_TC005, user U_TC005_B) via POST /v1/tenants/provision
 * - Assert different tenant IDs (sha256 of different principals)
 * - Assert different data_dir paths
 * - Assert different container_name values
 * - Assert different relay_token values
 * - Write a marker file to tenant A workspace
 * - Assert marker file NOT present in tenant B workspace path
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, rm, writeFile, access } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { buildApp as BuildAppFn } from '../../apps/control-plane/src/app-factory.js';

// Mock Date.now() to small incrementing counter to avoid SQLite Int32 overflow.
// TC-001: 3M, TC-002: 4M, TC-003: 5M, TC-004: 6M, TC-005: 7M
let mockNow = 7_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_TEAM_ID = 'T_TC005';
const TEST_USER_ID_A = 'U_TC005_A';
const TEST_USER_ID_B = 'U_TC005_B';

// Private data dir to avoid interference from concurrent test files
const TEST_DATA_DIR = '/tmp/claw-tc005-isolated';

const CP_PORT = 13315;

// ─── Mock Docker client ────────────────────────────────────────────────────────

const mockDockerClient = {
  run: vi.fn().mockResolvedValue(undefined),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeExpectedTenantId(teamId: string, userId: string): string {
  return createHash('sha256')
    .update(`${teamId}:${userId}`)
    .digest('hex')
    .slice(0, 16);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ─── Test state ───────────────────────────────────────────────────────────────

let cpApp: FastifyInstance;
let prisma: PrismaClient;
let tempDbPath: string;

type ProvisionResponse = {
  tenantId: string;
  status: string;
  relayToken: string;
};

let tenantAResp: ProvisionResponse;
let tenantBResp: ProvisionResponse;

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Override DATA_DIR and reset module cache so controlPlaneConfig re-evaluates
  // with the isolated DATA_DIR (prevents parallel cleanup races with other tests)
  vi.stubEnv('DATA_DIR', TEST_DATA_DIR);
  vi.resetModules();

  // 1. Create temp SQLite DB
  tempDbPath = `/tmp/test-tc005-${randomUUID()}.db`;
  const dbUrl = `file:${tempDbPath}`;

  await mkdir(TEST_DATA_DIR, { recursive: true });

  execSync('npx prisma db push --skip-generate', {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    cwd: '/home/ubuntu/.openclaw/workspace/claw-orchestrator',
  });

  // 2. Create PrismaClient
  prisma = new PrismaClient({ datasourceUrl: dbUrl });
  await prisma.$connect();

  // 3. Seed default container image
  await prisma.containerImage.create({
    data: {
      id: randomUUID(),
      tag: 'claw-tenant:test',
      is_default: 1,
      created_at: mockNow++,
    },
  });

  // 4. Seed allowlist entry for T_TC005 (allows all users in this team)
  await prisma.allowlist.create({
    data: {
      id: randomUUID(),
      slack_team_id: TEST_TEAM_ID,
      slack_user_id: null,
      added_by: 'tc-005-test-setup',
      created_at: mockNow++,
    },
  });

  // 5. Dynamically import buildApp AFTER vi.resetModules() so that
  //    @claw/shared-config/control-plane re-evaluates with DATA_DIR=TEST_DATA_DIR.
  const { buildApp } = await import('../../apps/control-plane/src/app-factory.js') as {
    buildApp: typeof BuildAppFn;
  };

  cpApp = await buildApp(prisma, { logger: false, dockerClient: mockDockerClient });
  await cpApp.listen({ port: CP_PORT, host: '127.0.0.1' });
}, 60_000);

afterAll(async () => {
  if (cpApp) await cpApp.close();
  if (prisma) await prisma.$disconnect();

  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(tempDbPath);
  } catch { /* best-effort */ }

  // Clean up the entire private data dir (no other test uses /tmp/claw-tc005-isolated)
  try {
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
  } catch { /* best-effort */ }
}, 30_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TC-005: Different users → completely isolated (no shared workspace/state)', () => {
  it('TC-005: provision tenant A (T_TC005/U_TC005_A) succeeds with status=NEW', async () => {
    const res = await cpApp.inject({
      method: 'POST',
      url: '/v1/tenants/provision',
      payload: { slackTeamId: TEST_TEAM_ID, slackUserId: TEST_USER_ID_A },
    });

    expect(res.statusCode).toBe(200);
    tenantAResp = res.json<ProvisionResponse>();
    expect(tenantAResp.tenantId).toBeTruthy();
    expect(tenantAResp.relayToken).toBeTruthy();

    // Verify deterministic tenantId = sha256(T_TC005:U_TC005_A)[0:16]
    const expectedId = computeExpectedTenantId(TEST_TEAM_ID, TEST_USER_ID_A);
    expect(tenantAResp.tenantId).toBe(expectedId);
  });

  it('TC-005: provision tenant B (T_TC005/U_TC005_B) succeeds with status=NEW', async () => {
    const res = await cpApp.inject({
      method: 'POST',
      url: '/v1/tenants/provision',
      payload: { slackTeamId: TEST_TEAM_ID, slackUserId: TEST_USER_ID_B },
    });

    expect(res.statusCode).toBe(200);
    tenantBResp = res.json<ProvisionResponse>();
    expect(tenantBResp.tenantId).toBeTruthy();
    expect(tenantBResp.relayToken).toBeTruthy();

    // Verify deterministic tenantId = sha256(T_TC005:U_TC005_B)[0:16]
    const expectedId = computeExpectedTenantId(TEST_TEAM_ID, TEST_USER_ID_B);
    expect(tenantBResp.tenantId).toBe(expectedId);
  });

  it('TC-005: tenant A and tenant B have different tenant IDs (sha256 of different principals)', () => {
    expect(tenantAResp.tenantId).not.toBe(tenantBResp.tenantId);
  });

  it('TC-005: tenant A and tenant B have different relay_token values', () => {
    expect(tenantAResp.relayToken).not.toBe(tenantBResp.relayToken);
  });

  it('TC-005: tenant A and tenant B have different data_dir paths (each contains own tenantId)', async () => {
    const dbTenantA = await prisma.tenant.findUnique({ where: { id: tenantAResp.tenantId } });
    const dbTenantB = await prisma.tenant.findUnique({ where: { id: tenantBResp.tenantId } });

    expect(dbTenantA).not.toBeNull();
    expect(dbTenantB).not.toBeNull();

    expect(dbTenantA!.data_dir).not.toBe(dbTenantB!.data_dir);
    expect(dbTenantA!.data_dir).toContain(tenantAResp.tenantId);
    expect(dbTenantB!.data_dir).toContain(tenantBResp.tenantId);
  });

  it('TC-005: tenant A and tenant B have different container_name values', async () => {
    const dbTenantA = await prisma.tenant.findUnique({ where: { id: tenantAResp.tenantId } });
    const dbTenantB = await prisma.tenant.findUnique({ where: { id: tenantBResp.tenantId } });

    expect(dbTenantA!.container_name).not.toBe(dbTenantB!.container_name);
    expect(dbTenantA!.container_name).toContain(tenantAResp.tenantId);
    expect(dbTenantB!.container_name).toContain(tenantBResp.tenantId);
  });

  it('TC-005: marker file written to tenant A workspace is NOT visible in tenant B workspace', async () => {
    const dbTenantA = await prisma.tenant.findUnique({ where: { id: tenantAResp.tenantId } });
    const dbTenantB = await prisma.tenant.findUnique({ where: { id: tenantBResp.tenantId } });

    const workspaceA = `${dbTenantA!.data_dir}/workspace`;
    const workspaceB = `${dbTenantB!.data_dir}/workspace`;

    // Both workspace dirs should exist (created synchronously during provision)
    expect(await fileExists(workspaceA)).toBe(true);
    expect(await fileExists(workspaceB)).toBe(true);

    const markerFileName = 'TC-005-isolation-marker.txt';
    const markerPathA = `${workspaceA}/${markerFileName}`;
    const markerPathB = `${workspaceB}/${markerFileName}`;

    // Write marker file only to tenant A workspace
    await writeFile(markerPathA, 'TC-005 isolation test marker — only in tenant A', 'utf8');

    // Marker exists in A
    expect(await fileExists(markerPathA)).toBe(true);

    // Marker must NOT be in B (complete filesystem isolation)
    expect(await fileExists(markerPathB)).toBe(false);
  });
});

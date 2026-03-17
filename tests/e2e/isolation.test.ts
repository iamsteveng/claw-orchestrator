/**
 * E2E Isolation Tests (TC-005)
 *
 * Tests:
 *   TC-005 — Different users → completely isolated tenants (different IDs, dirs, tokens)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, rm, writeFile, access } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';

let mockNow = 4_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);

import { buildApp } from '../../apps/control-plane/src/app-factory.js';

const TEST_DATA_DIR = process.env.DATA_DIR ?? '/tmp/claw-test-tenants';
const CP_PORT = 13303;

const mockDockerClient = {
  run: vi.fn().mockResolvedValue(undefined),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
};

let cpApp: FastifyInstance;
let prisma: PrismaClient;
let tempDbPath: string;

function computeTenantId(teamId: string, userId: string): string {
  return createHash('sha256').update(`${teamId}:${userId}`).digest('hex').slice(0, 16);
}

beforeAll(async () => {
  tempDbPath = `/tmp/test-isolation-${randomUUID()}.db`;
  const dbUrl = `file:${tempDbPath}`;
  await mkdir(TEST_DATA_DIR, { recursive: true });

  execSync('npx prisma db push --skip-generate', {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    cwd: '/home/ubuntu/.openclaw/workspace/claw-orchestrator',
  });

  prisma = new PrismaClient({ datasourceUrl: dbUrl });
  await prisma.$connect();

  await prisma.containerImage.create({
    data: { id: randomUUID(), tag: 'claw-tenant:isolation-test', is_default: 1, created_at: mockNow++ },
  });

  // Allowlist both users
  await prisma.allowlist.create({
    data: { id: randomUUID(), slack_team_id: 'T_ISO', slack_user_id: null, added_by: 'test', created_at: mockNow++ },
  });

  cpApp = await buildApp(prisma, { logger: false, dockerClient: mockDockerClient });
  await cpApp.ready();
}, 30_000);

afterAll(async () => {
  if (cpApp) await cpApp.close();
  if (prisma) await prisma.$disconnect();
  try { const { unlink } = await import('node:fs/promises'); await unlink(tempDbPath); } catch { /* best-effort */ }
  // Only delete tenant subdirs created by this test file to avoid racing with parallel test workers
  const isoTenants = [['T_ISO', 'U_ISO_A'], ['T_ISO', 'U_ISO_B']];
  for (const [team, user] of isoTenants) {
    const tid = createHash('sha256').update(`${team}:${user}`).digest('hex').slice(0, 16);
    try { await rm(`${TEST_DATA_DIR}/${tid}`, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}, 15_000);

describe('TC-005: Different users → completely isolated tenants', () => {
  const TEAM = 'T_ISO';
  const USER_A = 'U_ISO_A';
  const USER_B = 'U_ISO_B';
  let tenantIdA: string;
  let tenantIdB: string;
  let dataDirA: string;
  let dataDirB: string;
  let relayTokenA: string;
  let relayTokenB: string;

  it('provisions two tenants with different identities', async () => {
    const resA = await cpApp.inject({
      method: 'POST',
      url: '/v1/tenants/provision',
      payload: { slackTeamId: TEAM, slackUserId: USER_A },
    });
    expect(resA.statusCode).toBe(200);
    const bodyA = resA.json<{ tenantId: string; relayToken: string }>();
    tenantIdA = bodyA.tenantId;
    relayTokenA = bodyA.relayToken;

    const resB = await cpApp.inject({
      method: 'POST',
      url: '/v1/tenants/provision',
      payload: { slackTeamId: TEAM, slackUserId: USER_B },
    });
    expect(resB.statusCode).toBe(200);
    const bodyB = resB.json<{ tenantId: string; relayToken: string }>();
    tenantIdB = bodyB.tenantId;
    relayTokenB = bodyB.relayToken;
  });

  it('tenant IDs are different and deterministic', () => {
    const expectedA = computeTenantId(TEAM, USER_A);
    const expectedB = computeTenantId(TEAM, USER_B);

    expect(tenantIdA).toBe(expectedA);
    expect(tenantIdB).toBe(expectedB);
    expect(tenantIdA).not.toBe(tenantIdB);
    expect(tenantIdA).toHaveLength(16);
    expect(tenantIdB).toHaveLength(16);
  });

  it('data directories are different', async () => {
    const rowA = await prisma.tenant.findUnique({ where: { id: tenantIdA } });
    const rowB = await prisma.tenant.findUnique({ where: { id: tenantIdB } });

    dataDirA = rowA!.data_dir;
    dataDirB = rowB!.data_dir;

    expect(dataDirA).not.toBe(dataDirB);
    expect(dataDirA).toContain(tenantIdA);
    expect(dataDirB).toContain(tenantIdB);
  });

  it('container names are different', async () => {
    const rowA = await prisma.tenant.findUnique({ where: { id: tenantIdA } });
    const rowB = await prisma.tenant.findUnique({ where: { id: tenantIdB } });

    expect(rowA!.container_name).toBe(`claw-tenant-${tenantIdA}`);
    expect(rowB!.container_name).toBe(`claw-tenant-${tenantIdB}`);
    expect(rowA!.container_name).not.toBe(rowB!.container_name);
  });

  it('relay tokens are different', () => {
    expect(relayTokenA).not.toBe(relayTokenB);
    expect(relayTokenA).toHaveLength(64); // 32 bytes hex
    expect(relayTokenB).toHaveLength(64);
  });

  it('filesystem isolation: file in tenant A workspace not visible in tenant B path', async () => {
    const markerPath = `${dataDirA}/workspace/isolation-marker.txt`;
    const tenantBPath = `${dataDirB}/workspace/isolation-marker.txt`;

    // Write marker file to tenant A workspace
    await writeFile(markerPath, 'tenant-a-secret-data', 'utf8');

    // Verify marker exists for A
    let aExists = false;
    try { await access(markerPath); aExists = true; } catch { /* noop */ }
    expect(aExists).toBe(true);

    // Verify marker does NOT exist in B's path
    let bExists = false;
    try { await access(tenantBPath); bExists = true; } catch { /* noop */ }
    expect(bExists).toBe(false);
  });

  it('principals are different even within the same team', async () => {
    const rowA = await prisma.tenant.findUnique({ where: { id: tenantIdA } });
    const rowB = await prisma.tenant.findUnique({ where: { id: tenantIdB } });

    expect(rowA!.principal).toBe(`${TEAM}:${USER_A}`);
    expect(rowB!.principal).toBe(`${TEAM}:${USER_B}`);
    expect(rowA!.principal).not.toBe(rowB!.principal);
  });
});

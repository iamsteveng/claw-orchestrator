/**
 * TC-HOST-DATA-DIR: HOST_DATA_DIR / DATA_DIR path resolution for docker-in-docker
 *
 * Verifies that when HOST_DATA_DIR is set, the control plane uses it for
 * docker volume mount source paths rather than DATA_DIR. This supports
 * docker-in-docker deployments where the control plane runs inside a
 * container and DATA_DIR is the in-container path, but docker run must
 * reference the host path.
 *
 * Scenario 1: HOST_DATA_DIR set → volumes use HOST_DATA_DIR path
 * Scenario 2: HOST_DATA_DIR not set → volumes fall back to DATA_DIR path
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { buildApp as BuildAppFn } from '../../apps/control-plane/src/app-factory.js';

// ─── Module-level mock timestamp ─────────────────────────────────────────────

let mockNow = 33_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../apps/control-plane/src/seed-workspace.js', () => ({
  seedWorkspace: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../apps/control-plane/src/health-poll.js', () => ({
  pollUntilHealthy: vi.fn().mockImplementation(
    async (
      prisma: import('@prisma/client').PrismaClient,
      tenantId: string,
    ) => {
      const now = mockNow++;
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { status: 'ACTIVE', last_started_at: now, updated_at: now },
      });
      return 'healthy';
    },
  ),
}));

// ─── Helper: setup a fresh DB ─────────────────────────────────────────────────

async function createTestDb(label: string): Promise<{ prisma: PrismaClient; tempDbPath: string }> {
  const tempDbPath = `/tmp/test-tc-hdd-${label}-${randomUUID()}.db`;
  const dbUrl = `file:${tempDbPath}`;
  const result = spawnSync(`${process.cwd()}/node_modules/.bin/prisma`, ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    shell: false,
    cwd: process.cwd(),
  });
  if (result.status !== 0) {
    throw new Error('prisma db push failed: ' + String(result.stderr ?? result.stdout ?? 'unknown error'));
  }
  const prisma = new PrismaClient({ datasourceUrl: dbUrl });
  await prisma.$connect();
  return { prisma, tempDbPath };
}

// ─── Scenario 1: HOST_DATA_DIR is set ────────────────────────────────────────

describe('TC-HOST-DATA-DIR scenario 1: HOST_DATA_DIR set → volumes use HOST_DATA_DIR', () => {
  const DATA_DIR = '/tmp/claw-hdd-inner';
  const HOST_DATA_DIR = '/tmp/claw-hdd-outer';
  const TEAM_ID = 'T_HDD1';
  const USER_ID = 'U_HDD1';

  let app: FastifyInstance;
  let prisma: PrismaClient;
  let tempDbPath: string;
  let provisionedTenantId: string;

  const mockDc = {
    run: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue(null),
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  };

  beforeAll(async () => {
    vi.stubEnv('DATA_DIR', DATA_DIR);
    vi.stubEnv('HOST_DATA_DIR', HOST_DATA_DIR);
    vi.resetModules();

    await mkdir(DATA_DIR, { recursive: true });

    const db = await createTestDb('s1');
    prisma = db.prisma;
    tempDbPath = db.tempDbPath;

    // Seed default container image
    await prisma.containerImage.create({
      data: {
        id: randomUUID(),
        tag: 'claw-tenant:hdd-test',
        is_default: 1,
        created_at: mockNow++,
      },
    });

    // Seed allowlist entry
    await prisma.allowlist.create({
      data: {
        id: randomUUID(),
        slack_team_id: TEAM_ID,
        slack_user_id: null,
        added_by: 'tc-hdd-setup',
        created_at: mockNow++,
      },
    });

    const { buildApp } = await import('../../apps/control-plane/src/app-factory.js') as {
      buildApp: typeof BuildAppFn;
    };

    app = await buildApp(prisma, { logger: false, dockerClient: mockDc });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    // Allow in-flight background tasks (pollUntilHealthy, releaseStartupLock) to settle
    // before disconnecting the DB to prevent unhandled rejection errors.
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 150));

    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(tempDbPath);
    } catch { /* best-effort */ }
    try {
      await rm(DATA_DIR, { recursive: true, force: true });
    } catch { /* best-effort */ }
    vi.unstubAllEnvs();
  }, 30_000);

  it('provisions a tenant successfully', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants/provision',
      payload: { slackTeamId: TEAM_ID, slackUserId: USER_ID },
    });
    expect(res.statusCode, `Expected 200, got ${res.statusCode}: ${res.body}`).toBe(200);
    const body = res.json<{ tenantId: string; status: string }>();
    expect(body.status).toBe('NEW');
    provisionedTenantId = body.tenantId;
  });

  it('POST /start calls docker.run with HOST_DATA_DIR-based volume mounts', async () => {
    mockDc.run.mockClear();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${provisionedTenantId}/start`,
    });
    expect(res.statusCode, `Expected 202, got ${res.statusCode}: ${res.body}`).toBe(202);

    // Flush background async tasks (pollUntilHealthy + releaseStartupLock) before assertions
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockDc.run).toHaveBeenCalledOnce();
    const runOpts = mockDc.run.mock.calls[0][0] as { volumes: string[] };

    // Volumes should use HOST_DATA_DIR path, NOT DATA_DIR path
    expect(runOpts.volumes).toContain(`${HOST_DATA_DIR}/${provisionedTenantId}/home:/home/agent`);
    expect(runOpts.volumes).toContain(`${HOST_DATA_DIR}/${provisionedTenantId}/workspace:/workspace`);
    expect(runOpts.volumes).toContain(`${HOST_DATA_DIR}/${provisionedTenantId}/config:/home/agent/.config`);

    // Should NOT use the DATA_DIR path
    expect(runOpts.volumes).not.toContain(`${DATA_DIR}/${provisionedTenantId}/home:/home/agent`);
  });
});

// ─── Scenario 2: HOST_DATA_DIR not set → volumes fall back to DATA_DIR ────────

describe('TC-HOST-DATA-DIR scenario 2: no HOST_DATA_DIR → volumes use DATA_DIR', () => {
  const DATA_DIR = '/tmp/claw-hdd-dataonly';
  const TEAM_ID = 'T_HDD2';
  const USER_ID = 'U_HDD2';

  let app: FastifyInstance;
  let prisma: PrismaClient;
  let tempDbPath: string;
  let provisionedTenantId: string;

  const mockDc = {
    run: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue(null),
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  };

  beforeAll(async () => {
    vi.stubEnv('DATA_DIR', DATA_DIR);
    // Explicitly ensure HOST_DATA_DIR is not set
    delete process.env['HOST_DATA_DIR'];
    vi.resetModules();

    await mkdir(DATA_DIR, { recursive: true });

    const db = await createTestDb('s2');
    prisma = db.prisma;
    tempDbPath = db.tempDbPath;

    // Seed default container image
    await prisma.containerImage.create({
      data: {
        id: randomUUID(),
        tag: 'claw-tenant:hdd-test2',
        is_default: 1,
        created_at: mockNow++,
      },
    });

    // Seed allowlist entry
    await prisma.allowlist.create({
      data: {
        id: randomUUID(),
        slack_team_id: TEAM_ID,
        slack_user_id: null,
        added_by: 'tc-hdd-setup',
        created_at: mockNow++,
      },
    });

    const { buildApp } = await import('../../apps/control-plane/src/app-factory.js') as {
      buildApp: typeof BuildAppFn;
    };

    app = await buildApp(prisma, { logger: false, dockerClient: mockDc });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    // Allow in-flight background tasks (pollUntilHealthy, releaseStartupLock) to settle
    // before disconnecting the DB to prevent unhandled rejection errors.
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 150));

    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(tempDbPath);
    } catch { /* best-effort */ }
    try {
      await rm(DATA_DIR, { recursive: true, force: true });
    } catch { /* best-effort */ }
    vi.unstubAllEnvs();
  }, 30_000);

  it('provisions a tenant successfully', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants/provision',
      payload: { slackTeamId: TEAM_ID, slackUserId: USER_ID },
    });
    expect(res.statusCode, `Expected 200, got ${res.statusCode}: ${res.body}`).toBe(200);
    const body = res.json<{ tenantId: string; status: string }>();
    expect(body.status).toBe('NEW');
    provisionedTenantId = body.tenantId;
  });

  it('POST /start calls docker.run with DATA_DIR-based volume mounts (no HOST_DATA_DIR)', async () => {
    mockDc.run.mockClear();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${provisionedTenantId}/start`,
    });
    expect(res.statusCode, `Expected 202, got ${res.statusCode}: ${res.body}`).toBe(202);

    // Flush background async tasks (pollUntilHealthy + releaseStartupLock) before assertions
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockDc.run).toHaveBeenCalledOnce();
    const runOpts = mockDc.run.mock.calls[0][0] as { volumes: string[] };

    // Volumes should use DATA_DIR path since HOST_DATA_DIR is not set
    expect(runOpts.volumes).toContain(`${DATA_DIR}/${provisionedTenantId}/home:/home/agent`);
    expect(runOpts.volumes).toContain(`${DATA_DIR}/${provisionedTenantId}/workspace:/workspace`);
    expect(runOpts.volumes).toContain(`${DATA_DIR}/${provisionedTenantId}/config:/home/agent/.config`);
  });
});

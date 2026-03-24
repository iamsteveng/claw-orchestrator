/**
 * TC-reconcile-active: Reconcile ACTIVE tenants on startup
 *
 * Verifies that on startup, the reconcile() function:
 *  1. Resets ACTIVE tenants whose containers are NOT running → STOPPED
 *  2. Leaves ACTIVE tenants whose containers ARE running as ACTIVE
 *  3. Mixed scenario: some running, some not — only non-running ones reset
 *  4. No dockerClient provided → all ACTIVE tenants reset to STOPPED (safe default)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { reconcile } from '../../apps/control-plane/src/startup-reconciliation.js';

// Use small incrementing timestamps to stay within SQLite Int32 range
let mockNow = 17_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);

// ─── Test State ───────────────────────────────────────────────────────────────

let prisma: PrismaClient;
let tempDbPath: string;

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  tempDbPath = `/tmp/test-tc-reconcile-active-${randomUUID()}.db`;
  const dbUrl = `file:${tempDbPath}`;

  const result = spawnSync(`${process.cwd()}/node_modules/.bin/prisma`, ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    shell: false,
    cwd: process.cwd(),
  });
  if (result.status !== 0) throw new Error('prisma db push failed: ' + String(result.stderr ?? result.stdout ?? 'unknown error'));

  prisma = new PrismaClient({ datasourceUrl: dbUrl });
  await prisma.$connect();
}, 60_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(tempDbPath);
  } catch { /* best-effort */ }
}, 30_000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const noopLog = {
  info: (_msg: string) => {},
  warn: (_obj: unknown, _msg: string) => {},
};

async function createActiveTenant(suffix: string) {
  const id = randomUUID().slice(0, 16);
  await prisma.tenant.create({
    data: {
      id,
      principal: `T_RECONCILE_${suffix}:U_RECONCILE_${suffix}`,
      slack_team_id: `T_RECONCILE_${suffix}`,
      slack_user_id: `U_RECONCILE_${suffix}`,
      status: 'ACTIVE',
      relay_token: randomUUID(),
      container_name: `claw-tenant-${id}`,
      data_dir: `/tmp/claw-test-reconcile-${id}`,
      provision_attempts: 0,
      created_at: 1000,
      updated_at: 1000,
    },
  });
  return id;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TC-reconcile-active: Reconcile ACTIVE tenants on startup', () => {
  it('Test 1: ACTIVE tenant whose container is NOT running → reset to STOPPED', async () => {
    const tenantId = await createActiveTenant('T1_STOPPED');

    const mockDockerClient = {
      inspect: async (_containerName: string) => ({
        State: { Running: false },
      }),
    };

    await reconcile(prisma, noopLog, mockDockerClient);

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.status).toBe('STOPPED');
  });

  it('Test 2: ACTIVE tenant whose container IS running → stays ACTIVE', async () => {
    const tenantId = await createActiveTenant('T2_RUNNING');

    const mockDockerClient = {
      inspect: async (_containerName: string) => ({
        State: { Running: true },
      }),
    };

    await reconcile(prisma, noopLog, mockDockerClient);

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.status).toBe('ACTIVE');
  });

  it('Test 3: Mixed — some running, some not — only non-running ones reset to STOPPED', async () => {
    const runningId = await createActiveTenant('T3_RUNNING');
    const stoppedId1 = await createActiveTenant('T3_STOPPED1');
    const stoppedId2 = await createActiveTenant('T3_STOPPED2');

    const runningContainerName = `claw-tenant-${runningId}`;

    const mockDockerClient = {
      inspect: async (containerName: string) => {
        if (containerName === runningContainerName) {
          return { State: { Running: true } };
        }
        return { State: { Running: false } };
      },
    };

    await reconcile(prisma, noopLog, mockDockerClient);

    const running = await prisma.tenant.findUnique({ where: { id: runningId } });
    const stopped1 = await prisma.tenant.findUnique({ where: { id: stoppedId1 } });
    const stopped2 = await prisma.tenant.findUnique({ where: { id: stoppedId2 } });

    expect(running!.status).toBe('ACTIVE');
    expect(stopped1!.status).toBe('STOPPED');
    expect(stopped2!.status).toBe('STOPPED');
  });

  it('Test 4: No dockerClient provided → all ACTIVE tenants reset to STOPPED (safe default)', async () => {
    const tenantId = await createActiveTenant('T4_NODOCKERCTL');

    // No dockerClient — safe default is to reset to STOPPED
    await reconcile(prisma, noopLog, undefined);

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.status).toBe('STOPPED');
  });

  it('Test 4b: inspect throws → tenant reset to STOPPED', async () => {
    const tenantId = await createActiveTenant('T4B_THROWS');

    const mockDockerClient = {
      inspect: async (_containerName: string): Promise<{ State: { Running: boolean } } | null> => {
        throw new Error('docker daemon not available');
      },
    };

    await reconcile(prisma, noopLog, mockDockerClient);

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.status).toBe('STOPPED');
  });

  it('Test 4c: inspect returns null → tenant reset to STOPPED', async () => {
    const tenantId = await createActiveTenant('T4C_NULL');

    const mockDockerClient = {
      inspect: async (_containerName: string): Promise<{ State: { Running: boolean } } | null> => {
        return null;
      },
    };

    await reconcile(prisma, noopLog, mockDockerClient);

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.status).toBe('STOPPED');
  });

  it('Test 5: warn is called for each tenant reset to STOPPED', async () => {
    const tenantId = await createActiveTenant('T5_WARN');

    const warnCalls: Array<{ obj: unknown; msg: string }> = [];
    const spyLog = {
      info: (_msg: string) => {},
      warn: (obj: unknown, msg: string) => { warnCalls.push({ obj, msg }); },
    };

    const mockDockerClient = {
      inspect: async (_containerName: string) => ({
        State: { Running: false },
      }),
    };

    await reconcile(prisma, spyLog, mockDockerClient);

    const warnForTenant = warnCalls.find(
      (c) => (c.obj as { tenantId: string }).tenantId === tenantId,
    );
    expect(warnForTenant).toBeDefined();
    expect(warnForTenant!.msg).toBe('Tenant container not running on startup — reset to STOPPED');
    expect((warnForTenant!.obj as { containerName: string }).containerName).toBe(
      `claw-tenant-${tenantId}`,
    );
  });
});

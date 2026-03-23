/**
 * TC-022: Stop endpoint → ACTIVE → STOPPED transition
 *
 * Verifies the stop endpoint state machine:
 *  1. POST /stop on ACTIVE tenant returns {status: 'stopped'}
 *  2. Tenant DB status becomes STOPPED
 *  3. last_stopped_at is set
 *  4. TENANT_STOPPED audit event is written
 *  5. Second POST /stop is idempotent → returns {status: 'already_stopped'}
 *  6. dockerStop called only once (not on second call)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// ─── Module-level mock timestamp ─────────────────────────────────────────────

let mockNow = 11_000_000;
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

import { buildApp } from '../../apps/control-plane/src/app-factory.js';

// ─── Test State ───────────────────────────────────────────────────────────────

let app: FastifyInstance;
let prisma: PrismaClient;
let tempDbPath: string;
let tenantId: string;

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  tempDbPath = `/tmp/test-tc022-${randomUUID()}.db`;
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

  app = await buildApp(prisma, { logger: false, dockerClient: mockDockerClient });
  await app.ready();
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (prisma) await prisma.$disconnect();

  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(tempDbPath);
  } catch { /* best-effort */ }
}, 30_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TC-022: Stop endpoint → ACTIVE → STOPPED transition', () => {
  it('TC-022: creates ACTIVE tenant in DB via direct insert', async () => {
    tenantId = randomUUID();
    const now = mockNow++;

    await prisma.tenant.create({
      data: {
        id: tenantId,
        slack_team_id: 'T_TC022',
        slack_user_id: 'U_TC022',
        principal: 'T_TC022:U_TC022',
        status: 'ACTIVE',
        relay_token: randomUUID(),
        container_name: `claw-tenant-${tenantId}`,
        data_dir: `/tmp/claw-test-tc022/${tenantId}`,
        image_tag: 'claw-tenant:tc022',
        provision_attempts: 1,
        created_at: now,
        updated_at: now,
      },
    });

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.status).toBe('ACTIVE');
  });

  it('TC-022: POST /stop returns {status: "stopped"}', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/stop`,
      payload: {},
    });

    expect(res.statusCode, `Expected 200, got ${res.statusCode}: ${res.body}`).toBe(200);
    const body = res.json<{ status: string }>();
    expect(body.status).toBe('stopped');
  });

  it('TC-022: tenant DB status is STOPPED after /stop call', async () => {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.status).toBe('STOPPED');
  });

  it('TC-022: last_stopped_at is set on the tenant row', async () => {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.last_stopped_at).not.toBeNull();
    expect(typeof tenant!.last_stopped_at).toBe('bigint');
    expect(tenant!.last_stopped_at).toBeGreaterThan(0n);
  });

  it('TC-022: TENANT_STOPPED audit event written', async () => {
    const audit = await prisma.auditLog.findFirst({
      where: { tenant_id: tenantId, event_type: 'TENANT_STOPPED' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actor).toBe('system');

    const meta = JSON.parse(audit!.metadata ?? '{}') as { containerName: string };
    expect(meta.containerName).toBe(`claw-tenant-${tenantId}`);
  });

  it('TC-022: dockerStop was called once with the correct container name', async () => {
    expect(mockDockerClient.stop).toHaveBeenCalledTimes(1);
    expect(mockDockerClient.stop).toHaveBeenCalledWith(`claw-tenant-${tenantId}`, 10);
  });

  it('TC-022: second POST /stop is idempotent → returns {status: "already_stopped"}', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/stop`,
      payload: {},
    });

    expect(res.statusCode, `Expected 200, got ${res.statusCode}: ${res.body}`).toBe(200);
    const body = res.json<{ status: string }>();
    expect(body.status).toBe('already_stopped');
  });

  it('TC-022: dockerStop still called only once (idempotent second call does not call docker)', async () => {
    // Second /stop must not call docker again
    expect(mockDockerClient.stop).toHaveBeenCalledTimes(1);
  });
});

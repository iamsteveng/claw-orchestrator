/**
 * TC-031: Message forwarding → relay token mismatch → 401
 *
 * Verifies that the /v1/tenants/:id/message endpoint enforces relay token auth:
 *  1. Provision and activate tenant with known relay_token
 *  2. POST /v1/tenants/:id/message with wrong X-Relay-Token → 401 {ok:false, error:'Unauthorized'}
 *  3. POST /v1/tenants/:id/message with correct relay token → 200 (message forwarded)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';

// ─── Module-level mock timestamp ─────────────────────────────────────────────

let mockNow = 31_000_000;
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

const TEST_TEAM_ID = 'T_TC031';
const TEST_USER_ID = 'U_TC031';
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
  tempDbPath = `/tmp/test-tc031-${randomUUID()}.db`;
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
      tag: 'claw-tenant:tc031',
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

describe('TC-031: Message forwarding → relay token mismatch → 401', () => {
  // ── 1. Add allowlist entry ─────────────────────────────────────────────────

  it('TC-031: POST /v1/admin/allowlist adds U_TC031 to allowlist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/allowlist',
      payload: {
        slack_team_id: TEST_TEAM_ID,
        slack_user_id: TEST_USER_ID,
        added_by: 'admin:tc031',
      },
    });

    expect(res.statusCode, `Expected 200, got ${res.statusCode}: ${res.body}`).toBe(200);
    const body = res.json<{ id: string; created_at: number }>();
    expect(body.id).toBeTruthy();
  });

  // ── 2. Provision tenant ────────────────────────────────────────────────────

  it('TC-031: POST /v1/tenants/provision returns tenantId and relayToken', async () => {
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

  it('TC-031: POST /v1/tenants/:id/start activates tenant', async () => {
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

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant!.status, 'Tenant should be ACTIVE after start').toBe('ACTIVE');
  });

  // ── 4. Wrong relay token → 401 ────────────────────────────────────────────

  it('TC-031: POST /v1/tenants/:id/message with wrong X-Relay-Token returns 401 {ok:false, error:"Unauthorized"}', async () => {
    const wrongToken = 'wrong-token-' + randomUUID();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/message`,
      headers: { 'x-relay-token': wrongToken },
      payload: { slackEventId: 'E_TC031_WRONG', text: 'this should be rejected' },
    });

    expect(res.statusCode, `Expected 401, got ${res.statusCode}: ${res.body}`).toBe(401);
    const body = res.json<{ ok: boolean; error: string }>();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });

  // ── 5. Missing relay token → 401 ─────────────────────────────────────────

  it('TC-031: POST /v1/tenants/:id/message with missing X-Relay-Token returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/message`,
      payload: { slackEventId: 'E_TC031_MISSING', text: 'no token at all' },
    });

    expect(res.statusCode, `Expected 401, got ${res.statusCode}: ${res.body}`).toBe(401);
    const body = res.json<{ ok: boolean; error: string }>();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });

  // ── 6. No audit event for rejected messages ───────────────────────────────

  it('TC-031: no MESSAGE_DELIVERED event written for rejected (wrong token) messages', async () => {
    const audit = await prisma.auditLog.findFirst({
      where: { tenant_id: tenantId, event_type: 'MESSAGE_DELIVERED' },
    });
    expect(audit, 'No MESSAGE_DELIVERED should exist yet').toBeNull();
  });

  // ── 7. Correct relay token → 200 (message forwarded) ─────────────────────

  it('TC-031: POST /v1/tenants/:id/message with correct relay token returns 200', async () => {
    // Mock global fetch to simulate container returning a successful response
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
      payload: { slackEventId: 'E_TC031_OK', text: 'correct token, should forward' },
    });

    fetchSpy.mockRestore();

    expect(res.statusCode, `Expected 200, got ${res.statusCode}: ${res.body}`).toBe(200);
    const body = res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
  });

  // ── 8. MESSAGE_DELIVERED audit event written for successful delivery ──────

  it('TC-031: MESSAGE_DELIVERED audit event written after successful delivery', async () => {
    const audit = await prisma.auditLog.findFirst({
      where: { tenant_id: tenantId, event_type: 'MESSAGE_DELIVERED' },
    });
    expect(audit, 'MESSAGE_DELIVERED should be written').not.toBeNull();
    expect(audit!.actor).toBe('system');
    const meta = JSON.parse(audit!.metadata ?? '{}') as { slackEventId: string };
    expect(meta.slackEventId).toBe('E_TC031_OK');
  });
});

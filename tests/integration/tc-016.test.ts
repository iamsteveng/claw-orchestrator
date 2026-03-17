/**
 * TC-016: Control plane startup reconciliation → crashed state reset
 *
 * Verifies that on startup, the reconcile() function restores consistent DB state:
 *  1. PROVISIONING tenant → status=FAILED
 *  2. STARTING tenant → status=FAILED
 *  3. Expired startup_lock → deleted
 *  4. Stale PROCESSING message (updated_at > 2 min ago) → status=PENDING
 *  5. SYSTEM_STARTUP audit log entry written
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

import { reconcile } from '../../apps/control-plane/src/startup-reconciliation.js';

// Use small incrementing timestamps to stay within SQLite Int32 range
let mockNow = 16_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_DATA_DIR = process.env.DATA_DIR!;

// ─── Test State ───────────────────────────────────────────────────────────────

let prisma: PrismaClient;
let tempDbPath: string;

let provisioningTenantId: string;
let startingTenantId: string;
let activeTenantId: string;
let messageQueueId: string;

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  tempDbPath = `/tmp/test-tc016-${randomUUID()}.db`;
  const dbUrl = `file:${tempDbPath}`;

  await mkdir(TEST_DATA_DIR, { recursive: true });

  execSync('npx prisma db push --skip-generate', {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    cwd: '/home/ubuntu/.openclaw/workspace/claw-orchestrator',
  });

  prisma = new PrismaClient({ datasourceUrl: dbUrl });
  await prisma.$connect();

  // Use small fake timestamps well within SQLite Int32 range.
  // mockNow starts at 16_000_000. "Old" timestamps near 0 ensure the delta
  // is >> 120_000 (2 min in ms), so stale-check and expiry-check both fire.
  const fiveMinutesAgo = 1000;
  const threeMinutesAgo = 2000;

  // ── 1. PROVISIONING tenant ─────────────────────────────────────────────────
  provisioningTenantId = randomUUID().slice(0, 16);
  await prisma.tenant.create({
    data: {
      id: provisioningTenantId,
      principal: `T_TC016_PROV:U_TC016_PROV`,
      slack_team_id: 'T_TC016_PROV',
      slack_user_id: 'U_TC016_PROV',
      status: 'PROVISIONING',
      relay_token: randomUUID(),
      container_name: `claw-tenant-${provisioningTenantId}`,
      data_dir: `${TEST_DATA_DIR}/${provisioningTenantId}`,
      provision_attempts: 0,
      created_at: fiveMinutesAgo,
      updated_at: fiveMinutesAgo,
    },
  });

  // ── 2. STARTING tenant (also has the expired startup_lock) ─────────────────
  startingTenantId = randomUUID().slice(0, 16);
  await prisma.tenant.create({
    data: {
      id: startingTenantId,
      principal: `T_TC016_START:U_TC016_START`,
      slack_team_id: 'T_TC016_START',
      slack_user_id: 'U_TC016_START',
      status: 'STARTING',
      relay_token: randomUUID(),
      container_name: `claw-tenant-${startingTenantId}`,
      data_dir: `${TEST_DATA_DIR}/${startingTenantId}`,
      provision_attempts: 0,
      created_at: fiveMinutesAgo,
      updated_at: fiveMinutesAgo,
    },
  });

  // ── 3. Expired startup_lock for the STARTING tenant ────────────────────────
  await prisma.startupLock.create({
    data: {
      tenant_id: startingTenantId,
      locked_by: randomUUID(),
      acquired_at: fiveMinutesAgo,
      expires_at: threeMinutesAgo, // already expired
    },
  });

  // ── 4. ACTIVE tenant with a stale PROCESSING message ──────────────────────
  activeTenantId = randomUUID().slice(0, 16);
  await prisma.tenant.create({
    data: {
      id: activeTenantId,
      principal: `T_TC016_ACTIVE:U_TC016_ACTIVE`,
      slack_team_id: 'T_TC016_ACTIVE',
      slack_user_id: 'U_TC016_ACTIVE',
      status: 'ACTIVE',
      relay_token: randomUUID(),
      container_name: `claw-tenant-${activeTenantId}`,
      data_dir: `${TEST_DATA_DIR}/${activeTenantId}`,
      provision_attempts: 0,
      created_at: fiveMinutesAgo,
      updated_at: fiveMinutesAgo,
    },
  });

  messageQueueId = randomUUID();
  await prisma.messageQueue.create({
    data: {
      id: messageQueueId,
      tenant_id: activeTenantId,
      slack_event_id: `EVT_TC016_${randomUUID().slice(0, 8)}`,
      payload: JSON.stringify({ text: 'stale processing message' }),
      status: 'PROCESSING',
      attempts: 1,
      created_at: fiveMinutesAgo,
      updated_at: threeMinutesAgo, // 3 minutes ago — stale
    },
  });
}, 60_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(tempDbPath);
  } catch { /* best-effort */ }
}, 30_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TC-016: Control plane startup reconciliation → crashed state reset', () => {
  it('TC-016: reconcile() runs without error', async () => {
    const log = {
      info: (_msg: string) => {},
      warn: (_obj: unknown, _msg: string) => {},
    };
    await expect(reconcile(prisma, log)).resolves.toBeUndefined();
  });

  it('TC-016: PROVISIONING tenant → status=FAILED after reconciliation', async () => {
    const tenant = await prisma.tenant.findUnique({ where: { id: provisioningTenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.status).toBe('FAILED');
    expect(tenant!.error_message).toBe('Process crashed during startup');
  });

  it('TC-016: STARTING tenant → status=FAILED after reconciliation', async () => {
    const tenant = await prisma.tenant.findUnique({ where: { id: startingTenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.status).toBe('FAILED');
    expect(tenant!.error_message).toBe('Process crashed during startup');
  });

  it('TC-016: expired startup_lock → deleted after reconciliation', async () => {
    const lock = await prisma.startupLock.findUnique({
      where: { tenant_id: startingTenantId },
    });
    expect(lock).toBeNull();
  });

  it('TC-016: stale PROCESSING message → status=PENDING after reconciliation', async () => {
    const msg = await prisma.messageQueue.findUnique({ where: { id: messageQueueId } });
    expect(msg).not.toBeNull();
    expect(msg!.status).toBe('PENDING');
  });

  it('TC-016: SYSTEM_STARTUP audit log entry written', async () => {
    const audit = await prisma.auditLog.findFirst({
      where: { event_type: 'SYSTEM_STARTUP' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actor).toBe('system');
    expect(audit!.tenant_id).toBeNull();
  });

  it('TC-016: ACTIVE tenant status unchanged (reconcile only resets PROVISIONING/STARTING)', async () => {
    const tenant = await prisma.tenant.findUnique({ where: { id: activeTenantId } });
    expect(tenant).not.toBeNull();
    expect(tenant!.status).toBe('ACTIVE');
  });
});

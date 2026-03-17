/**
 * TC-030: Queue reaping → DELIVERED rows older than 7 days deleted
 *
 * Verifies correct retention policy for message_queue rows:
 *  - DELIVERED rows older than 7 days → deleted
 *  - DELIVERED rows 3 days old → retained
 *  - FAILED rows older than 30 days → deleted
 *  - FAILED rows 15 days old → retained
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { reapMessageQueue } from '../../apps/scheduler/src/reaper.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const NOW = Date.now();
const EIGHT_DAYS_AGO = NOW - 8 * 24 * 60 * 60 * 1000;
const THREE_DAYS_AGO = NOW - 3 * 24 * 60 * 60 * 1000;
const THIRTY_ONE_DAYS_AGO = NOW - 31 * 24 * 60 * 60 * 1000;
const FIFTEEN_DAYS_AGO = NOW - 15 * 24 * 60 * 60 * 1000;

// ─── Test State ───────────────────────────────────────────────────────────────

let prisma: PrismaClient;
let tempDbPath: string;

// IDs for the inserted rows
let delivered8dId: string;
let delivered3dId: string;
let failed31dId: string;
let failed15dId: string;

// We need a real tenant to satisfy the FK constraint
let tenantId: string;

const noopLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  tempDbPath = `/tmp/test-tc030-${randomUUID()}.db`;
  const dbUrl = `file:${tempDbPath}`;

  execSync('npx prisma db push --skip-generate', {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    cwd: '/home/ubuntu/.openclaw/workspace/claw-orchestrator',
  });

  prisma = new PrismaClient({ datasourceUrl: dbUrl });
  await prisma.$connect();

  // Create a minimal tenant for FK
  tenantId = randomUUID();
  await prisma.tenant.create({
    data: {
      id: tenantId,
      slack_team_id: 'T_TC030',
      slack_user_id: 'U_TC030',
      status: 'ACTIVE',
      container_name: `claw-tc030-${tenantId.slice(0, 8)}`,
      data_dir: `/tmp/claw-tc030-${tenantId}`,
      relay_token: randomUUID(),
      created_at: NOW,
      updated_at: NOW,
    },
  });

  // Insert the 4 test rows
  delivered8dId = randomUUID();
  delivered3dId = randomUUID();
  failed31dId = randomUUID();
  failed15dId = randomUUID();

  await prisma.messageQueue.createMany({
    data: [
      {
        id: delivered8dId,
        tenant_id: tenantId,
        slack_event_id: `E_TC030_DEL8D_${delivered8dId}`,
        payload: '{}',
        status: 'DELIVERED',
        attempts: 1,
        created_at: EIGHT_DAYS_AGO,
        updated_at: EIGHT_DAYS_AGO,
      },
      {
        id: delivered3dId,
        tenant_id: tenantId,
        slack_event_id: `E_TC030_DEL3D_${delivered3dId}`,
        payload: '{}',
        status: 'DELIVERED',
        attempts: 1,
        created_at: THREE_DAYS_AGO,
        updated_at: THREE_DAYS_AGO,
      },
      {
        id: failed31dId,
        tenant_id: tenantId,
        slack_event_id: `E_TC030_FAIL31D_${failed31dId}`,
        payload: '{}',
        status: 'FAILED',
        attempts: 3,
        created_at: THIRTY_ONE_DAYS_AGO,
        updated_at: THIRTY_ONE_DAYS_AGO,
      },
      {
        id: failed15dId,
        tenant_id: tenantId,
        slack_event_id: `E_TC030_FAIL15D_${failed15dId}`,
        payload: '{}',
        status: 'FAILED',
        attempts: 3,
        created_at: FIFTEEN_DAYS_AGO,
        updated_at: FIFTEEN_DAYS_AGO,
      },
    ],
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

describe('TC-030: Queue reaping → DELIVERED rows older than 7 days deleted', () => {
  it('TC-030: reapMessageQueue deletes correct rows and retains others', async () => {
    // Run the reaper
    await reapMessageQueue(prisma, noopLog);

    // 8-day-old DELIVERED → should be deleted
    const delivered8d = await prisma.messageQueue.findUnique({ where: { id: delivered8dId } });
    expect(delivered8d, '8-day-old DELIVERED row should be deleted').toBeNull();

    // 3-day-old DELIVERED → should be retained
    const delivered3d = await prisma.messageQueue.findUnique({ where: { id: delivered3dId } });
    expect(delivered3d, '3-day-old DELIVERED row should be retained').not.toBeNull();

    // 31-day-old FAILED → should be deleted
    const failed31d = await prisma.messageQueue.findUnique({ where: { id: failed31dId } });
    expect(failed31d, '31-day-old FAILED row should be deleted').toBeNull();

    // 15-day-old FAILED → should be retained
    const failed15d = await prisma.messageQueue.findUnique({ where: { id: failed15dId } });
    expect(failed15d, '15-day-old FAILED row should be retained').not.toBeNull();
  });
});

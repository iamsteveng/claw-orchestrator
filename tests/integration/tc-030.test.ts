/**
 * TC-030: Queue reaping → DELIVERED rows older than 7 days deleted
 *
 * Verifies correct retention policy for message_queue rows:
 *  - DELIVERED rows older than 7 days → deleted
 *  - DELIVERED rows 3 days old → retained
 *  - FAILED rows older than 30 days → deleted
 *  - FAILED rows 15 days old → retained
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// ─── Mock Date.now to a value within INT32 range that allows 30-day offsets ──
// INT32 max = 2_147_483_647
// Use 1_800_000_000 as "now"; offsets back 31 days give -878_400_000 (valid INT32)
const MOCK_NOW = 1_800_000_000;
vi.spyOn(Date, 'now').mockReturnValue(MOCK_NOW);

import { reapMessageQueue } from '../../apps/scheduler/src/reaper.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const EIGHT_DAYS_AGO      = MOCK_NOW - 8  * 24 * 60 * 60 * 1000; // 1_108_800_000
const THREE_DAYS_AGO      = MOCK_NOW - 3  * 24 * 60 * 60 * 1000; // 1_540_800_000
const THIRTY_ONE_DAYS_AGO = MOCK_NOW - 31 * 24 * 60 * 60 * 1000; //  -878_400_000 (valid INT32)
const FIFTEEN_DAYS_AGO    = MOCK_NOW - 15 * 24 * 60 * 60 * 1000; //   504_000_000

// ─── Test State ───────────────────────────────────────────────────────────────

let prisma: PrismaClient;
let tempDbPath: string;

let delivered8dId: string;
let delivered3dId: string;
let failed31dId: string;
let failed15dId: string;

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

  const result = spawnSync(`${process.cwd()}/node_modules/.bin/prisma`, ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    shell: false,
    cwd: process.cwd(),
  });
  if (result.status !== 0) throw new Error('prisma db push failed: ' + String(result.stderr ?? result.stdout ?? 'unknown error'));

  prisma = new PrismaClient({ datasourceUrl: dbUrl });
  await prisma.$connect();

  // Create a minimal tenant for FK constraint (use small timestamp values)
  tenantId = randomUUID();
  await prisma.tenant.create({
    data: {
      id: tenantId,
      slack_team_id: 'T_TC030',
      slack_user_id: 'U_TC030',
      principal: 'T_TC030:U_TC030',
      status: 'ACTIVE',
      container_name: `claw-tc030-${tenantId.slice(0, 8)}`,
      data_dir: `/tmp/claw-tc030-${tenantId}`,
      relay_token: randomUUID(),
      created_at: 1_000_000,
      updated_at: 1_000_000,
    },
  });

  // Insert the 4 test rows with controlled timestamps
  delivered8dId = randomUUID();
  delivered3dId = randomUUID();
  failed31dId   = randomUUID();
  failed15dId   = randomUUID();

  await prisma.messageQueue.createMany({
    data: [
      {
        id: delivered8dId,
        tenant_id: tenantId,
        slack_event_id: `E_TC030_DEL8D_${delivered8dId.slice(0, 8)}`,
        payload: '{}',
        status: 'DELIVERED',
        attempts: 1,
        created_at: EIGHT_DAYS_AGO,
        updated_at: EIGHT_DAYS_AGO,
      },
      {
        id: delivered3dId,
        tenant_id: tenantId,
        slack_event_id: `E_TC030_DEL3D_${delivered3dId.slice(0, 8)}`,
        payload: '{}',
        status: 'DELIVERED',
        attempts: 1,
        created_at: THREE_DAYS_AGO,
        updated_at: THREE_DAYS_AGO,
      },
      {
        id: failed31dId,
        tenant_id: tenantId,
        slack_event_id: `E_TC030_FAIL31D_${failed31dId.slice(0, 8)}`,
        payload: '{}',
        status: 'FAILED',
        attempts: 3,
        created_at: THIRTY_ONE_DAYS_AGO,
        updated_at: THIRTY_ONE_DAYS_AGO,
      },
      {
        id: failed15dId,
        tenant_id: tenantId,
        slack_event_id: `E_TC030_FAIL15D_${failed15dId.slice(0, 8)}`,
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
  it('TC-030: reapMessageQueue applies correct retention policy', async () => {
    // Run the reaper (Date.now() is mocked to MOCK_NOW = 1_800_000_000)
    await reapMessageQueue(prisma, noopLog);

    // 8-day-old DELIVERED → should be deleted (older than 7-day cutoff)
    const delivered8d = await prisma.messageQueue.findUnique({ where: { id: delivered8dId } });
    expect(delivered8d, '8-day-old DELIVERED row should be deleted').toBeNull();

    // 3-day-old DELIVERED → should be retained (within 7-day window)
    const delivered3d = await prisma.messageQueue.findUnique({ where: { id: delivered3dId } });
    expect(delivered3d, '3-day-old DELIVERED row should be retained').not.toBeNull();

    // 31-day-old FAILED → should be deleted (older than 30-day cutoff)
    const failed31d = await prisma.messageQueue.findUnique({ where: { id: failed31dId } });
    expect(failed31d, '31-day-old FAILED row should be deleted').toBeNull();

    // 15-day-old FAILED → should be retained (within 30-day window)
    const failed15d = await prisma.messageQueue.findUnique({ where: { id: failed15dId } });
    expect(failed15d, '15-day-old FAILED row should be retained').not.toBeNull();
  });
});

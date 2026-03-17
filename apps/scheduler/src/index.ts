import { PrismaClient } from '@prisma/client';
import { schedulerConfig } from '@claw/shared-config/scheduler';
import { stopIdleTenants } from './idle-stop.js';
import { checkDiskQuotas, checkHostDisk } from './disk-quota.js';
import { reapMessageQueue, sweepStaleLocks, cleanArchiveDirectories, archiveAuditLog } from './reaper.js';
import { retryQueuedTenants } from './capacity-retry.js';
import pino from 'pino';

const log = pino({ base: { service: 'scheduler' } });
const prisma = new PrismaClient();

const idleStopMs = schedulerConfig.IDLE_STOP_HOURS * 60 * 60 * 1000;
const DISK_CHECK_TICKS = Math.max(1, Math.round(5 * 60 * 1000 / schedulerConfig.SCHEDULER_INTERVAL_MS));
// Hourly reaping: every 60 ticks at 60s interval (or every tick for simplicity in tests)
const REAP_TICKS = Math.max(1, Math.round(60 * 60 * 1000 / schedulerConfig.SCHEDULER_INTERVAL_MS));
let tickCount = 0;

async function runJobs(): Promise<void> {
  // Stale lock sweep runs on every tick
  await sweepStaleLocks(prisma, log);

  await stopIdleTenants(prisma, schedulerConfig.CONTROL_PLANE_URL, idleStopMs, log);

  await retryQueuedTenants(
    prisma,
    schedulerConfig.CONTROL_PLANE_URL,
    schedulerConfig.MAX_ACTIVE_TENANTS,
    schedulerConfig.ACTIVE_TENANTS_OVERFLOW_POLICY,
    log,
  );

  tickCount++;
  if (tickCount % DISK_CHECK_TICKS === 0) {
    await checkDiskQuotas(prisma, schedulerConfig.SLACK_BOT_TOKEN, log);
    await checkHostDisk(prisma, schedulerConfig.DATA_MOUNT, log);
  }

  if (tickCount % REAP_TICKS === 0) {
    await reapMessageQueue(prisma, log);
    await cleanArchiveDirectories(schedulerConfig.DATA_MOUNT, log);
    await archiveAuditLog(prisma, schedulerConfig.DATA_MOUNT, log);
  }
}

async function main(): Promise<void> {
  log.info({ service: 'scheduler', interval: schedulerConfig.SCHEDULER_INTERVAL_MS }, `Scheduler started, interval=${schedulerConfig.SCHEDULER_INTERVAL_MS}ms`);

  // Run once on startup
  await runJobs().catch((err) => log.error({ err }, 'Scheduler job error'));

  const interval = setInterval(() => {
    void runJobs().catch((err) => log.error({ err }, 'Scheduler job error'));
  }, schedulerConfig.SCHEDULER_INTERVAL_MS);

  function shutdown(): void {
    log.info({ service: 'scheduler' }, 'Scheduler shutting down...');
    clearInterval(interval);
    void prisma.$disconnect().then(() => process.exit(0));
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Fatal scheduler error:', err);
  process.exit(1);
});

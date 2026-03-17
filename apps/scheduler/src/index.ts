import { PrismaClient } from '@prisma/client';
import { schedulerConfig } from '@claw/shared-config/scheduler';
import { stopIdleTenants } from './idle-stop.js';
import { checkDiskQuotas, checkHostDisk } from './disk-quota.js';
import pino from 'pino';

const log = pino({ base: { service: 'scheduler' } });
const prisma = new PrismaClient();

const idleStopMs = schedulerConfig.IDLE_STOP_HOURS * 60 * 60 * 1000;
const DISK_CHECK_TICKS = Math.max(1, Math.round(5 * 60 * 1000 / schedulerConfig.SCHEDULER_INTERVAL_MS));
let tickCount = 0;

async function runJobs(): Promise<void> {
  await stopIdleTenants(prisma, schedulerConfig.CONTROL_PLANE_URL, idleStopMs, log);

  tickCount++;
  if (tickCount % DISK_CHECK_TICKS === 0) {
    await checkDiskQuotas(prisma, schedulerConfig.SLACK_BOT_TOKEN, log);
    await checkHostDisk(prisma, schedulerConfig.DATA_MOUNT, log);
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

import { PrismaClient } from '@prisma/client';
import { controlPlaneConfig } from '@claw/shared-config/control-plane';
import { AuditEventType, TenantStatus } from '@claw/shared-types';
import { execSync } from 'node:child_process';
import { buildApp } from './app-factory.js';
import { seedDefaultImage } from './container-image.js';

// ─── Startup reconciliation ───────────────────────────────────────────────────

async function reconcile(prisma: PrismaClient, log: { info: (msg: string) => void; warn: (obj: unknown, msg: string) => void }): Promise<void> {
  const now = Date.now();
  const twoMinutesAgo = now - 2 * 60 * 1000;

  // Delete expired startup locks
  await prisma.startupLock.deleteMany({
    where: { expires_at: { lt: now } },
  });

  // Reset PROCESSING messages stuck for > 2 minutes
  await prisma.messageQueue.updateMany({
    where: {
      status: 'PROCESSING',
      updated_at: { lt: twoMinutesAgo },
    },
    data: { status: 'PENDING', updated_at: now },
  });

  // Mark in-flight tenant starts as FAILED
  await prisma.tenant.updateMany({
    where: {
      status: { in: [TenantStatus.STARTING, TenantStatus.PROVISIONING] },
    },
    data: {
      status: TenantStatus.FAILED,
      error_message: 'Process crashed during startup',
      updated_at: now,
    },
  });

  // Write SYSTEM_STARTUP audit event
  await prisma.auditLog.create({
    data: {
      id: crypto.randomUUID(),
      tenant_id: null,
      event_type: AuditEventType.SYSTEM_STARTUP,
      actor: 'system',
      metadata: JSON.stringify({ uptime_ms: 0 }),
      created_at: now,
    },
  });

  // Seed default container image if not already set
  await seedDefaultImage(prisma);

  log.info('Startup reconciliation complete');
}

// ─── Server startup ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const app = await buildApp(prisma, { logger: true });

  // Run prisma migrate deploy
  try {
    execSync('npx prisma migrate deploy', {
      env: { ...process.env, DATABASE_URL: controlPlaneConfig.DATABASE_URL },
      stdio: 'pipe',
    });
    app.log.info('Prisma migrations applied');
  } catch (err) {
    app.log.warn({ err }, 'prisma migrate deploy failed (may be first run or non-fatal)');
  }

  await prisma.$connect();
  await reconcile(prisma, app.log);

  await app.listen({
    port: controlPlaneConfig.CONTROL_PLANE_PORT,
    host: '0.0.0.0',
  });

  app.log.info(
    { port: controlPlaneConfig.CONTROL_PLANE_PORT },
    'Control plane started',
  );

  // ─── Graceful shutdown ────────────────────────────────────────────────────────

  async function shutdown(): Promise<void> {
    app.log.info('Shutting down...');
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

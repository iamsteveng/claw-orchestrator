import { PrismaClient } from '@prisma/client';
import { controlPlaneConfig } from '@claw/shared-config/control-plane';
import { TenantStatus } from '@claw/shared-types';
import { execSync } from 'node:child_process';
import { buildApp } from './app-factory.js';
import { reconcile } from './startup-reconciliation.js';
import { pollUntilHealthy } from './health-poll.js';

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

  const dc = (await import('@claw/docker-client')).DockerClient;
  await reconcile(prisma, app.log, dc);

  // Resume health polling for any tenants left in STARTING status
  // (reconcile leaves them STARTING only if their container is still running)
  const startingTenants = await prisma.tenant.findMany({
    where: { status: TenantStatus.STARTING },
    select: { id: true, container_name: true },
  });

  if (startingTenants.length > 0) {
    app.log.info({ count: startingTenants.length }, 'Resuming health polling for STARTING tenants after reconciliation');
    for (const tenant of startingTenants) {
      if (tenant.container_name) {
        void pollUntilHealthy(prisma, tenant.id, tenant.container_name, TenantStatus.STARTING, app.log, dc.inspect.bind(dc));
      }
    }
  }

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

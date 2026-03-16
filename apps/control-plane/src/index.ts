import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { controlPlaneConfig } from '@claw/shared-config/control-plane';
import { AuditEventType, TenantStatus } from '@claw/shared-types';
import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';

const startedAt = Date.now();

const app = Fastify({
  logger: {
    level: controlPlaneConfig.LOG_LEVEL,
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty' }
      : undefined,
  },
});

const prisma = new PrismaClient();

// ─── Startup reconciliation ───────────────────────────────────────────────────

async function reconcile(): Promise<void> {
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

  app.log.info('Startup reconciliation complete');
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', async (_req, reply) => {
  return reply.send({ ok: true, uptime: Date.now() - startedAt });
});

// POST /v1/tenants/provision
app.post<{
  Body: { slackTeamId: string; slackUserId: string };
}>('/v1/tenants/provision', async (req, reply) => {
  const { slackTeamId, slackUserId } = req.body;

  const principal = `${slackTeamId}:${slackUserId}`;
  const tenantId = createHash('sha256').update(principal).digest('hex').slice(0, 16);

  // Check for existing tenant (idempotency)
  const existing = await prisma.tenant.findUnique({ where: { principal } });
  if (existing) {
    if (existing.status === TenantStatus.FAILED && existing.provision_attempts >= 3) {
      return reply.status(409).send({ error: 'Max provision attempts reached' });
    }
    return reply.send({ tenantId: existing.id, status: existing.status });
  }

  const dataDir = `${controlPlaneConfig.DATA_DIR}/${tenantId}`;
  const relayToken = randomBytes(32).toString('hex');
  const now = Date.now();

  // Create DB row with status=PROVISIONING
  await prisma.tenant.create({
    data: {
      id: tenantId,
      principal,
      slack_team_id: slackTeamId,
      slack_user_id: slackUserId,
      status: TenantStatus.PROVISIONING,
      relay_token: relayToken,
      container_name: `claw-tenant-${tenantId}`,
      data_dir: dataDir,
      provision_attempts: 0,
      created_at: now,
      updated_at: now,
    },
  });

  try {
    // Create tenant directories
    for (const subdir of ['home', 'workspace', 'config', 'logs', 'secrets']) {
      await mkdir(`${dataDir}/${subdir}`, { recursive: true });
    }

    // Write relay token to secrets
    await writeFile(`${dataDir}/secrets/relay-token`, relayToken, { encoding: 'utf8' });

    // Mark tenant as NEW (provisioning complete; container start is separate)
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { status: TenantStatus.NEW, updated_at: Date.now() },
    });

    // Write audit event
    await prisma.auditLog.create({
      data: {
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        event_type: AuditEventType.TENANT_PROVISIONED,
        actor: 'system',
        metadata: JSON.stringify({ slackTeamId, slackUserId }),
        created_at: Date.now(),
      },
    });

    app.log.info({ tenantId }, 'Tenant provisioned');
    return reply.send({ tenantId, status: TenantStatus.NEW });
  } catch (err) {
    app.log.error({ err, tenantId }, 'Tenant provisioning failed');

    // Rollback: cleanup directories
    try {
      await rm(dataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }

    // Mark as FAILED, increment provision_attempts
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        status: TenantStatus.FAILED,
        error_message: err instanceof Error ? err.message : String(err),
        provision_attempts: { increment: 1 },
        updated_at: Date.now(),
      },
    });

    // Write failure audit event
    await prisma.auditLog.create({
      data: {
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        event_type: AuditEventType.TENANT_PROVISION_FAILED,
        actor: 'system',
        metadata: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        created_at: Date.now(),
      },
    });

    return reply.status(500).send({ error: 'Provisioning failed' });
  }
});

// ─── Server startup ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
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
  await reconcile();

  await app.listen({
    port: controlPlaneConfig.CONTROL_PLANE_PORT,
    host: '0.0.0.0',
  });

  app.log.info(
    { port: controlPlaneConfig.CONTROL_PLANE_PORT },
    'Control plane started',
  );
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  app.log.info('Shutting down...');
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

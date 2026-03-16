import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { controlPlaneConfig } from '@claw/shared-config/control-plane';
import { AuditEventType, TenantStatus } from '@claw/shared-types';
import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { seedWorkspace } from './seed-workspace.js';
import { acquireStartupLock, releaseStartupLock } from './startup-lock.js';
import { pollUntilHealthy } from './health-poll.js';

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

    // Seed workspace template files (including AGENTS.md merge logic)
    await seedWorkspace(`${dataDir}/workspace`, controlPlaneConfig.TEMPLATES_DIR);

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

// POST /v1/tenants/:tenantId/start
app.post<{
  Params: { tenantId: string };
  Body: { imageTag?: string };
}>('/v1/tenants/:tenantId/start', async (req, reply) => {
  const { tenantId } = req.params;
  const { imageTag } = req.body ?? {};

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    return reply.status(404).send({ error: 'Tenant not found' });
  }

  // Cannot start a DELETING tenant
  if (tenant.status === TenantStatus.DELETING) {
    return reply.status(409).send({ error: 'Tenant is being deleted' });
  }

  // Idempotent: already active
  if (tenant.status === TenantStatus.ACTIVE) {
    return reply.send({ status: 'active' });
  }

  const requestId = crypto.randomUUID();

  // Try to acquire startup lock
  const { acquired } = await acquireStartupLock(prisma, tenantId, requestId);
  if (!acquired) {
    return reply.status(202).send({ status: 'already_starting' });
  }

  try {
    // Check capacity cap
    const activeCount = await prisma.tenant.count({
      where: { status: TenantStatus.ACTIVE },
    });

    if (activeCount >= controlPlaneConfig.MAX_ACTIVE_TENANTS) {
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { queued_for_start_at: Date.now(), updated_at: Date.now() },
      });
      return reply.status(202).send({ status: 'queued' });
    }

    const now = Date.now();
    const containerName = `claw-tenant-${tenantId}`;
    const previousStatus = tenant.status;

    // Write IMAGE_UPDATED audit event if image_tag changed
    if (imageTag && imageTag !== tenant.image_tag) {
      await prisma.auditLog.create({
        data: {
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          event_type: AuditEventType.IMAGE_UPDATED,
          actor: 'system',
          metadata: JSON.stringify({ oldTag: tenant.image_tag, newTag: imageTag }),
          created_at: now,
        },
      });
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { image_tag: imageTag, updated_at: now },
      });
    }

    // Set status to STARTING
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { status: TenantStatus.STARTING, last_started_at: now, updated_at: now },
    });

    // Start the container (dynamic import required: docker-client is ESM-only)
    const { DockerClient } = await import('@claw/docker-client');
    await DockerClient.start(containerName);

    // Launch health polling in background (does not block response)
    void pollUntilHealthy(prisma, tenantId, containerName, previousStatus, app.log)
      .finally(() => void releaseStartupLock(prisma, tenantId, requestId));

    app.log.info({ tenantId }, 'Container start initiated');
    return reply.status(202).send({ status: 'starting' });
  } catch (err) {
    await releaseStartupLock(prisma, tenantId, requestId);
    app.log.error({ tenantId, err }, 'Failed to start tenant container');
    return reply.status(500).send({ error: 'Failed to start container' });
  }
});

// POST /v1/tenants/:tenantId/message
app.post<{
  Params: { tenantId: string };
  Body: import('@claw/shared-types').RelayMessageRequest;
}>('/v1/tenants/:tenantId/message', async (req, reply) => {
  const { tenantId } = req.params;
  const relayToken = req.headers['x-relay-token'];
  const startedAt = Date.now();

  // Container hostname derived from tenantId (no DB lookup needed)
  const containerName = `claw-tenant-${tenantId}`;

  // Fetch tenant for token validation and status check
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    return reply.status(404).send({ ok: false, error: 'Tenant not found' });
  }

  // Validate relay token
  if (!relayToken || relayToken !== tenant.relay_token) {
    return reply.status(401).send({ ok: false, error: 'Unauthorized' });
  }

  // Tenant must be ACTIVE
  if (tenant.status !== TenantStatus.ACTIVE) {
    return reply.status(503).send({ ok: false, error: 'Tenant not active' });
  }

  const { slackEventId } = req.body;
  const runtimeUrl = `http://${containerName}:3100/message`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4 * 60 * 1000); // 4-minute timeout

  let success = false;
  let responseBody: import('@claw/shared-types').RelayMessageResponse;

  try {
    const res = await fetch(runtimeUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-relay-token': tenant.relay_token,
      },
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });

    const duration_ms = Date.now() - startedAt;
    responseBody = await res.json() as import('@claw/shared-types').RelayMessageResponse;

    if (res.ok && responseBody.ok) {
      success = true;
      const now = Date.now();

      // Update last_activity_at
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { last_activity_at: now, updated_at: now },
      });

      // Write MESSAGE_DELIVERED audit event
      await prisma.auditLog.create({
        data: {
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          event_type: AuditEventType.MESSAGE_DELIVERED,
          actor: 'system',
          metadata: JSON.stringify({ slackEventId, duration_ms }),
          created_at: now,
        },
      });

      app.log.info({ tenantId, slackEventId, duration_ms }, 'Message delivered');
      return reply.send(responseBody);
    }

    // Non-200 response from runtime
    app.log.warn({ tenantId, slackEventId, duration_ms, status: res.status }, 'Message delivery failed');
  } catch (err) {
    const duration_ms = Date.now() - startedAt;
    app.log.error({ tenantId, slackEventId, duration_ms, err }, 'Message forwarding error');
    responseBody = { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }

  if (!success) {
    const now = Date.now();

    // Increment message attempts; write MESSAGE_FAILED audit only if attempts >= 3
    const queueRow = await prisma.messageQueue.findUnique({
      where: { slack_event_id: slackEventId },
    });

    if (queueRow) {
      const newAttempts = queueRow.attempts + 1;
      await prisma.messageQueue.update({
        where: { id: queueRow.id },
        data: { attempts: newAttempts, updated_at: now },
      });

      if (newAttempts >= 3) {
        await prisma.auditLog.create({
          data: {
            id: crypto.randomUUID(),
            tenant_id: tenantId,
            event_type: AuditEventType.MESSAGE_FAILED,
            actor: 'system',
            metadata: JSON.stringify({ slackEventId, attempts: newAttempts }),
            created_at: now,
          },
        });
      }
    }
  }

  return reply.status(502).send(responseBody! ?? { ok: false, error: 'Message delivery failed' });
});

// POST /v1/tenants/:tenantId/stop
app.post<{
  Params: { tenantId: string };
  Body: { actor?: string };
}>('/v1/tenants/:tenantId/stop', async (req, reply) => {
  const { tenantId } = req.params;
  const actor = req.body?.actor ?? 'system';

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    return reply.status(404).send({ error: 'Tenant not found' });
  }

  if (tenant.status === TenantStatus.STOPPED) {
    return reply.send({ status: 'already_stopped' });
  }

  const containerName = `claw-tenant-${tenantId}`;
  const now = Date.now();

  // Stop container (best-effort: if it fails, still mark STOPPED)
  try {
    const { DockerClient } = await import('@claw/docker-client');
    await DockerClient.stop(containerName, 10);
  } catch (err) {
    app.log.warn({ tenantId, err }, 'dockerStop failed; marking STOPPED anyway');
  }

  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      status: TenantStatus.STOPPED,
      last_stopped_at: now,
      queued_for_start_at: null,
      updated_at: now,
    },
  });

  await prisma.auditLog.create({
    data: {
      id: crypto.randomUUID(),
      tenant_id: tenantId,
      event_type: AuditEventType.TENANT_STOPPED,
      actor,
      metadata: JSON.stringify({ containerName }),
      created_at: now,
    },
  });

  app.log.info({ tenantId, actor }, 'Tenant stopped');
  return reply.send({ status: 'stopped' });
});

// DELETE /v1/tenants/:tenantId
app.delete<{
  Params: { tenantId: string };
}>('/v1/tenants/:tenantId', async (req, reply) => {
  const { tenantId } = req.params;

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    return reply.status(404).send({ error: 'Tenant not found' });
  }

  if (tenant.status === TenantStatus.DELETING || tenant.deleted_at !== null) {
    return reply.status(409).send({ error: 'Tenant is already being deleted or was deleted' });
  }

  const now = Date.now();

  // Immediately mark as DELETING
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { status: TenantStatus.DELETING, deletion_requested_at: now, updated_at: now },
  });

  const containerName = `claw-tenant-${tenantId}`;
  const { DockerClient } = await import('@claw/docker-client');

  // Stop container (best-effort)
  try {
    await DockerClient.stop(containerName, 10);
  } catch (err) {
    app.log.warn({ tenantId, err }, 'dockerStop failed during deletion (continuing)');
  }

  // Remove container (best-effort)
  try {
    await DockerClient.rm(containerName);
  } catch (err) {
    app.log.warn({ tenantId, err }, 'dockerRm failed during deletion (continuing)');
  }

  // Archive tenant directory
  const srcDir = tenant.data_dir;
  const archiveBase = srcDir.replace('/data/tenants/', '/data/tenants-archive/');
  let archiveDir = archiveBase;
  try {
    const { access } = await import('node:fs/promises');
    try {
      await access(archiveDir);
      // Archive path already exists — append timestamp to avoid collision
      archiveDir = `${archiveBase}-${now}`;
    } catch {
      // Path doesn't exist — we can use archiveBase
    }
    const { rename } = await import('node:fs/promises');
    await rename(srcDir, archiveDir);
  } catch (err) {
    app.log.warn({ tenantId, err }, 'Failed to archive tenant directory (continuing)');
  }

  // Purge message queue rows
  await prisma.messageQueue.deleteMany({ where: { tenant_id: tenantId } });

  // Purge startup lock
  await prisma.startupLock.deleteMany({ where: { tenant_id: tenantId } });

  // Soft-delete tenant row
  const deletedAt = Date.now();
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { deleted_at: deletedAt, updated_at: deletedAt },
  });

  // Write audit event
  await prisma.auditLog.create({
    data: {
      id: crypto.randomUUID(),
      tenant_id: tenantId,
      event_type: AuditEventType.TENANT_DELETED,
      actor: 'admin',
      metadata: JSON.stringify({ containerName, archiveDir }),
      created_at: deletedAt,
    },
  });

  app.log.info({ tenantId }, 'Tenant deleted');
  return reply.send({ deleted: true });
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

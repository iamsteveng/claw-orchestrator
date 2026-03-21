import Fastify, { type FastifyInstance } from 'fastify';
import { type PrismaClient } from '@prisma/client';
import { controlPlaneConfig } from '@claw/shared-config/control-plane';
import { AuditEventType, TenantStatus } from '@claw/shared-types';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { seedWorkspace } from './seed-workspace.js';
import { acquireStartupLock, releaseStartupLock } from './startup-lock.js';
import { pollUntilHealthy } from './health-poll.js';
import { isAllowed } from './allowlist.js';
import { getDefaultImage } from './container-image.js';
import { buildDockerRunOptions } from './docker-run-options.js';

// Minimal interface for the docker operations used by the control plane
export interface DockerClientLike {
  run: (opts: import('@claw/docker-client').DockerRunOptions) => Promise<void>;
  start: (containerName: string) => Promise<void>;
  stop: (containerName: string, timeoutSeconds?: number) => Promise<void>;
  rm: (containerName: string) => Promise<void>;
  inspect?: (containerName: string) => Promise<{ State?: { Running?: boolean }; NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> } } | null>;
}

export async function buildApp(
  prisma: PrismaClient,
  options?: { logger?: boolean; dockerClient?: DockerClientLike },
): Promise<FastifyInstance> {
  const startedAt = Date.now();
  const enableLogger = options?.logger ?? false;

  const app = Fastify({
    logger: enableLogger
      ? {
          level: controlPlaneConfig.LOG_LEVEL,
          transport:
            process.env.NODE_ENV !== 'production'
              ? { target: 'pino-pretty' }
              : undefined,
        }
      : false,
  });

  // ─── Routes ───────────────────────────────────────────────────────────────────

  app.get('/health', async (_req, reply) => {
    return reply.send({ ok: true, uptime: Date.now() - startedAt });
  });

  // POST /v1/tenants/provision
  app.post<{
    Body: { slackTeamId: string; slackUserId: string };
  }>('/v1/tenants/provision', async (req, reply) => {
    const { slackTeamId, slackUserId } = req.body;

    // Allowlist check
    const allowed = await isAllowed(prisma, slackTeamId, slackUserId);
    if (!allowed) {
      await prisma.auditLog.create({
        data: {
          id: crypto.randomUUID(),
          tenant_id: null,
          event_type: AuditEventType.ACCESS_DENIED,
          actor: 'system',
          metadata: JSON.stringify({ slackTeamId, slackUserId }),
          created_at: Date.now(),
        },
      });
      return reply.status(403).send({ error: 'Access denied' });
    }

    const principal = `${slackTeamId}:${slackUserId}`;
    const tenantId = createHash('sha256').update(principal).digest('hex').slice(0, 16);

    // Check for existing tenant (idempotency)
    const existing = await prisma.tenant.findUnique({ where: { principal } });
    if (existing) {
      if (existing.status === TenantStatus.FAILED && existing.provision_attempts >= 3) {
        return reply.status(409).send({ error: 'Max provision attempts reached' });
      }
      return reply.send({ tenantId: existing.id, status: existing.status, relayToken: existing.relay_token });
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
      // Create tenant directories (top-level)
      for (const subdir of ['home', 'workspace', 'config', 'logs', 'secrets']) {
        await mkdir(`${dataDir}/${subdir}`, { recursive: true });
        await chmod(`${dataDir}/${subdir}`, 0o777);
      }

      // Create agent-specific directories inside home (needed for bind-mount targets)
      const agentDirs = [
        `${dataDir}/home/.openclaw`,
        `${dataDir}/home/.openclaw/agents`,
        `${dataDir}/home/.openclaw/agents/main`,
        `${dataDir}/home/.openclaw/agents/main/agent`,
        `${dataDir}/home/.claude`,
      ];
      for (const dir of agentDirs) {
        await mkdir(dir, { recursive: true });
        await chmod(dir, 0o777);
      }

      // Seed openclaw.json config for the gateway
      await writeFile(
        `${dataDir}/home/.openclaw/openclaw.json`,
        JSON.stringify({ gateway: { mode: 'local', bind: 'any' } }, null, 2),
        { encoding: 'utf8' },
      );

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
      return reply.send({ tenantId, status: TenantStatus.NEW, relayToken });
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
    Body: Record<string, never>;
  }>('/v1/tenants/:tenantId/start', async (req, reply) => {
    const { tenantId } = req.params;

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

      // Resolve the current default image tag from DB.
      const imageTag = await getDefaultImage(prisma);

      // Write IMAGE_UPDATED audit event if image_tag changed from previously recorded value
      if (imageTag !== tenant.image_tag) {
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

      // Start the container
      // Use injected dockerClient if provided (for testing), otherwise dynamic import
      const dc = options?.dockerClient ?? (await import('@claw/docker-client')).DockerClient;
      if (previousStatus === TenantStatus.NEW) {
        // First-time start: create and run a new container with resource limits + bind mounts
        const runOpts = buildDockerRunOptions({
          tenantId,
          image: imageTag,
          dataDir: tenant.data_dir,
          resourceOverrides: tenant.resource_overrides,
        });
        await dc.run(runOpts);
      } else {
        // Restart an existing (stopped) container
        await dc.start(containerName);
      }

      // Launch health polling in background (does not block response)
      void pollUntilHealthy(prisma, tenantId, containerName, previousStatus, app.log, dc.inspect?.bind(dc))
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

    // Check allowlist: revoked access should block message delivery
    const allowed = await isAllowed(prisma, tenant.slack_team_id, tenant.slack_user_id);
    if (!allowed) {
      return reply.status(403).send({ ok: false, error: 'Access revoked' });
    }

    // Block message delivery when disk quota is exceeded
    if (tenant.disk_quota_exceeded === 1) {
      return reply.status(507).send({ ok: false, error: 'Disk quota exceeded' });
    }

    // Tenant must be ACTIVE
    if (tenant.status !== TenantStatus.ACTIVE) {
      return reply.status(503).send({ ok: false, error: 'Tenant not active' });
    }

    const { slackEventId } = req.body;

    // Resolve container IP via docker inspect (host cannot resolve container names)
    let containerHost = containerName;
    try {
      const dc = options?.dockerClient ?? (await import('@claw/docker-client')).DockerClient;
      const inspectResult = await dc.inspect?.(containerName);
      const networkSettings = (inspectResult as { NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> } } | null | undefined)?.NetworkSettings;
      const ip = networkSettings?.Networks ? Object.values(networkSettings.Networks)[0]?.IPAddress : undefined;
      if (ip) containerHost = ip;
    } catch {
      // Fall back to container name
    }

    const runtimeUrl = `http://${containerHost}:3100/message`;
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
      const dc = options?.dockerClient ?? (await import('@claw/docker-client')).DockerClient;
      await dc.stop(containerName, 10);
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
    const dc = options?.dockerClient ?? (await import('@claw/docker-client')).DockerClient;

    // Stop container (best-effort)
    try {
      await dc.stop(containerName, 10);
    } catch (err) {
      app.log.warn({ tenantId, err }, 'dockerStop failed during deletion (continuing)');
    }

    // Remove container (best-effort)
    try {
      await dc.rm(containerName);
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

  // POST /v1/admin/allowlist
  app.post<{
    Body: { slack_team_id: string; slack_user_id?: string; added_by: string; note?: string };
  }>('/v1/admin/allowlist', async (req, reply) => {
    const { slack_team_id, slack_user_id, added_by, note } = req.body;
    const now = Date.now();
    const id = crypto.randomUUID();

    await prisma.allowlist.create({
      data: {
        id,
        slack_team_id,
        slack_user_id: slack_user_id ?? null,
        added_by,
        note: note ?? null,
        created_at: now,
      },
    });

    await prisma.auditLog.create({
      data: {
        id: crypto.randomUUID(),
        tenant_id: null,
        event_type: AuditEventType.ACCESS_GRANTED,
        actor: added_by,
        metadata: JSON.stringify({ slack_team_id, slack_user_id }),
        created_at: now,
      },
    });

    return reply.send({ id, created_at: now });
  });

  // DELETE /v1/admin/allowlist/:id
  app.delete<{
    Params: { id: string };
  }>('/v1/admin/allowlist/:id', async (req, reply) => {
    const { id } = req.params;
    const now = Date.now();

    const entry = await prisma.allowlist.findUnique({ where: { id } });
    if (!entry) {
      return reply.status(404).send({ error: 'Allowlist entry not found' });
    }

    await prisma.allowlist.update({
      where: { id },
      data: { revoked_at: now },
    });

    await prisma.auditLog.create({
      data: {
        id: crypto.randomUUID(),
        tenant_id: null,
        event_type: AuditEventType.ACCESS_REVOKED,
        actor: 'admin',
        metadata: JSON.stringify({ slack_team_id: entry.slack_team_id, slack_user_id: entry.slack_user_id }),
        created_at: now,
      },
    });

    return reply.send({ revoked: true });
  });

  // GET /v1/admin/audit
  app.get<{
    Querystring: { tenant_id?: string; event_type?: string; limit?: string; before?: string };
  }>('/v1/admin/audit', async (req, reply) => {
    const { tenant_id, event_type, limit: limitStr, before: beforeStr } = req.query;
    const limit = Math.min(parseInt(limitStr ?? '100', 10) || 100, 500);
    const before = beforeStr ? parseInt(beforeStr, 10) : undefined;

    const where: Record<string, unknown> = {};
    if (tenant_id) where.tenant_id = tenant_id;
    if (event_type) where.event_type = event_type;
    if (before) where.created_at = { lt: before };

    const [events, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    return reply.send({
      events: events.map((e: (typeof events)[number]) => ({
        ...e,
        created_at: Number(e.created_at),
        metadata: e.metadata ? JSON.parse(e.metadata) as unknown : null,
      })),
      total,
    });
  });

  // GET /v1/admin/images
  app.get('/v1/admin/images', async (_req, reply) => {
    const images = await prisma.containerImage.findMany({
      orderBy: { created_at: 'desc' },
    });
    return reply.send({
      images: images.map((img) => ({ ...img, created_at: Number(img.created_at) })),
    });
  });

  // POST /v1/admin/images/:id/promote
  app.post<{
    Params: { id: string };
  }>('/v1/admin/images/:id/promote', async (req, reply) => {
    const { id } = req.params;

    const target = await prisma.containerImage.findUnique({ where: { id } });
    if (!target) {
      return reply.status(404).send({ error: 'Image not found' });
    }

    const now = Date.now();

    // In a transaction: set all is_default=0, set target is_default=1
    await prisma.$transaction(async (tx) => {
      // Deprecate current defaults
      await tx.containerImage.updateMany({
        where: { is_default: 1, id: { not: id } },
        data: { is_default: 0, deprecated_at: now },
      });
      // Promote target
      await tx.containerImage.update({
        where: { id },
        data: { is_default: 1 },
      });
    });

    // Write IMAGE_UPDATED audit event
    await prisma.auditLog.create({
      data: {
        id: crypto.randomUUID(),
        tenant_id: null,
        event_type: AuditEventType.IMAGE_UPDATED,
        actor: 'admin',
        metadata: JSON.stringify({ promotedTag: target.tag }),
        created_at: now,
      },
    });

    app.log.info({ imageId: id, tag: target.tag }, 'Image promoted to default');
    return reply.send({ promoted: true, tag: target.tag });
  });

  return app;
}

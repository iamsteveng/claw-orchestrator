import { PrismaClient } from '@prisma/client';
import { AuditEventType, TenantStatus } from '@claw/shared-types';
import { controlPlaneConfig } from '@claw/shared-config/control-plane';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import { seedWorkspace } from './seed-workspace.js';

export interface ProvisionRequest {
  slackTeamId: string;
  slackUserId: string;
}

export interface ProvisionResult {
  tenantId: string;
  status: string;
}

function computeTenantId(slackTeamId: string, slackUserId: string): string {
  const principal = `${slackTeamId}:${slackUserId}`;
  return createHash('sha256').update(principal).digest('hex').slice(0, 16);
}

export async function provisionTenant(
  prisma: PrismaClient,
  req: ProvisionRequest,
  log: FastifyBaseLogger,
): Promise<ProvisionResult> {
  const { slackTeamId, slackUserId } = req;
  const principal = `${slackTeamId}:${slackUserId}`;
  const tenantId = computeTenantId(slackTeamId, slackUserId);

  // Check if tenant already exists
  const existing = await prisma.tenant.findUnique({
    where: { principal },
  });

  if (existing !== null) {
    log.info({ tenantId }, 'Tenant already exists, returning existing record');
    return { tenantId: existing.id, status: existing.status };
  }

  // Check max provision attempts for FAILED tenants
  const failedTenant = await prisma.tenant.findFirst({
    where: {
      slack_team_id: slackTeamId,
      slack_user_id: slackUserId,
      status: TenantStatus.FAILED,
    },
  });

  if (failedTenant !== null && failedTenant.provision_attempts >= 3) {
    throw Object.assign(new Error('Max provision attempts reached'), { statusCode: 409 });
  }

  const now = Date.now();
  const relayToken = randomBytes(32).toString('hex');
  const containerName = `claw-tenant-${tenantId}`;
  const dataDir = `/data/tenants/${tenantId}`;

  // Create tenant DB row with PROVISIONING status
  const tenant = await prisma.tenant.create({
    data: {
      id: tenantId,
      principal,
      slack_team_id: slackTeamId,
      slack_user_id: slackUserId,
      status: TenantStatus.PROVISIONING,
      relay_token: relayToken,
      container_name: containerName,
      data_dir: dataDir,
      provision_attempts: 1,
      created_at: now,
      updated_at: now,
    },
  });

  log.info({ tenantId }, 'Tenant row created with PROVISIONING status');

  // Create directories and write relay token
  try {
    const dirs = [
      `${dataDir}/home`,
      `${dataDir}/workspace`,
      `${dataDir}/config`,
      `${dataDir}/logs`,
      `${dataDir}/secrets`,
    ];

    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(`${dataDir}/secrets/relay-token`, relayToken, 'utf8');

    // Seed workspace template files (including AGENTS.md merge logic)
    await seedWorkspace(`${dataDir}/workspace`, controlPlaneConfig.TEMPLATES_DIR);

    log.info({ tenantId }, 'Tenant directories and relay token created');

    // Set status to NEW after successful directory creation
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        status: TenantStatus.NEW,
        provisioned_at: Date.now(),
        updated_at: Date.now(),
      },
    });

    // Write TENANT_PROVISIONED audit event
    await prisma.auditLog.create({
      data: {
        id: randomUUID(),
        tenant_id: tenantId,
        event_type: AuditEventType.TENANT_PROVISIONED,
        actor: 'control-plane',
        metadata: JSON.stringify({ slackTeamId, slackUserId, dataDir }),
        created_at: Date.now(),
      },
    });

    log.info({ tenantId }, 'Tenant provisioned successfully');

    return { tenantId: tenant.id, status: TenantStatus.NEW };
  } catch (err) {
    log.error({ tenantId, err }, 'Tenant provisioning failed, rolling back');

    // Write TENANT_PROVISION_FAILED audit event
    try {
      await prisma.auditLog.create({
        data: {
          id: randomUUID(),
          tenant_id: tenantId,
          event_type: AuditEventType.TENANT_PROVISION_FAILED,
          actor: 'control-plane',
          metadata: JSON.stringify({
            slackTeamId,
            slackUserId,
            error: err instanceof Error ? err.message : String(err),
          }),
          created_at: Date.now(),
        },
      });
    } catch (auditErr) {
      log.error({ tenantId, auditErr }, 'Failed to write TENANT_PROVISION_FAILED audit event');
    }

    // Update tenant status to FAILED
    try {
      await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          status: TenantStatus.FAILED,
          error_message: err instanceof Error ? err.message : String(err),
          updated_at: Date.now(),
        },
      });
    } catch (updateErr) {
      log.error({ tenantId, updateErr }, 'Failed to update tenant status to FAILED');
    }

    // Cleanup directories
    try {
      await rm(dataDir, { recursive: true, force: true });
    } catch (rmErr) {
      log.error({ tenantId, rmErr }, 'Failed to cleanup tenant directories during rollback');
    }

    throw err;
  }
}

import { PrismaClient } from '@prisma/client';
import { AuditEventType, TenantStatus } from '@claw/shared-types';
import { controlPlaneConfig } from '@claw/shared-config/control-plane';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, copyFile, chmod } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import { seedWorkspace } from './seed-workspace.js';
import { rollbackProvisioning } from './rollback-provisioning.js';

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
      `${dataDir}/home/.openclaw`,
      `${dataDir}/home/.openclaw/agents/main/agent`,
      `${dataDir}/home/.claude`,
      `${dataDir}/workspace`,
      `${dataDir}/config`,
      `${dataDir}/logs`,
      `${dataDir}/secrets`,
    ];

    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(`${dataDir}/secrets/relay-token`, relayToken, 'utf8');

    // Seed openclaw config so the gateway starts without interactive setup.
    // The home dir is bind-mounted over /home/agent, hiding the image's baked-in config.
    await copyFile(
      controlPlaneConfig.OPENCLAW_CONFIG_TEMPLATE,
      `${dataDir}/home/.openclaw/openclaw.json`,
    );

    // Copy credential files into the tenant home so openclaw can write usage stats
    // back to auth-profiles.json. Read-only bind mounts cause EBUSY on rename.
    const hostHome = process.env.HOME ?? '/root';
    const credFilePairs: [string, string][] = [
      [
        `${hostHome}/.openclaw/agents/main/agent/auth-profiles.json`,
        `${dataDir}/home/.openclaw/agents/main/agent/auth-profiles.json`,
      ],
      [
        `${hostHome}/.claude/.credentials.json`,
        `${dataDir}/home/.claude/.credentials.json`,
      ],
    ];
    for (const [src, dest] of credFilePairs) {
      try {
        await copyFile(src, dest);
        await chmod(dest, 0o644);
      } catch {
        // Best-effort — container may still work with partial credentials
      }
    }

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
    const rollbackError = err instanceof Error ? err : new Error(String(err));
    await rollbackProvisioning(prisma, tenantId, dataDir, rollbackError, log);
    throw err;
  }
}

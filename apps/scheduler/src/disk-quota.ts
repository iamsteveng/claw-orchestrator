import type { PrismaClient } from '@prisma/client';
import { AuditEventType, TenantStatus } from '@claw/shared-types';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);

const QUOTA_BYTES = 12 * 1024 * 1024 * 1024; // 12 GB total
const WARN_THRESHOLD = 0.9;   // 90%
const EXCEEDED_THRESHOLD = 1.0; // 100%
const CLEAR_THRESHOLD = 0.95;   // below 95% → clear exceeded flag
const HOST_WARN_THRESHOLD = 0.8;  // 80% host disk
const HOST_UNHEALTHY_THRESHOLD = 0.95; // 95% host disk

export type DiskQuotaLog = {
  info: (ctx: object, msg: string) => void;
  warn: (ctx: object, msg: string) => void;
  error: (ctx: object, msg: string) => void;
};

export type ExecFileFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

const defaultExecFileFn: ExecFileFn = async (cmd, args) => {
  const result = await execFileAsync(cmd, args, { encoding: 'utf8' });
  return { stdout: result.stdout };
};

/** Runs `du -sb <path>` and returns bytes used, or null on error. */
export async function getDiskUsageBytes(
  path: string,
  execFn: ExecFileFn = defaultExecFileFn,
): Promise<number | null> {
  try {
    const result = await execFn('du', ['-sb', path]);
    const bytes = parseInt(result.stdout.split('\t')[0], 10);
    return isNaN(bytes) ? null : bytes;
  } catch {
    return null;
  }
}

/**
 * Checks disk quota for all active tenants every call.
 * - At ≥90% quota: DISK_QUOTA_WARNING audit event + Slack warning
 * - At ≥100% quota: DISK_QUOTA_EXCEEDED audit, sets disk_quota_exceeded=1
 * - Below 95%: clears disk_quota_exceeded=0 if previously set
 */
export async function checkDiskQuotas(
  prisma: PrismaClient,
  slackBotToken: string,
  log: DiskQuotaLog,
  getDiskFn: typeof getDiskUsageBytes = getDiskUsageBytes,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const tenants = await prisma.tenant.findMany({
    where: {
      status: { in: [TenantStatus.ACTIVE, TenantStatus.STARTING] },
      deleted_at: null,
    },
    select: { id: true, data_dir: true, disk_quota_exceeded: true, slack_user_id: true },
  });

  for (const tenant of tenants) {
    const usedBytes = await getDiskFn(tenant.data_dir);
    if (usedBytes === null) continue;

    const ratio = usedBytes / QUOTA_BYTES;
    const now = Date.now();

    if (ratio >= EXCEEDED_THRESHOLD) {
      // Set disk_quota_exceeded flag
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { disk_quota_exceeded: 1, updated_at: now },
      });
      await prisma.auditLog.create({
        data: {
          id: randomUUID(),
          tenant_id: tenant.id,
          event_type: AuditEventType.DISK_QUOTA_EXCEEDED,
          actor: 'scheduler',
          metadata: JSON.stringify({ usedBytes, quotaBytes: QUOTA_BYTES }),
          created_at: now,
        },
      });
      log.warn({ tenantId: tenant.id, usedBytes }, 'Disk quota exceeded');
      await sendSlackDm(tenant.slack_user_id, '⚠️ Your workspace has exceeded its disk quota. New messages are blocked until you free space.', slackBotToken, fetchFn);

    } else if (ratio >= WARN_THRESHOLD) {
      await prisma.auditLog.create({
        data: {
          id: randomUUID(),
          tenant_id: tenant.id,
          event_type: AuditEventType.DISK_QUOTA_WARNING,
          actor: 'scheduler',
          metadata: JSON.stringify({ usedBytes, quotaBytes: QUOTA_BYTES, ratio }),
          created_at: now,
        },
      });
      log.warn({ tenantId: tenant.id, usedBytes, ratio }, 'Disk quota warning');
      await sendSlackDm(tenant.slack_user_id, 'You can free space by clearing build caches: rm -rf ~/.cache/ and /workspace/node_modules/', slackBotToken, fetchFn);

    } else if (ratio < CLEAR_THRESHOLD && tenant.disk_quota_exceeded === 1) {
      // Usage has dropped below 95% — clear the exceeded flag
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { disk_quota_exceeded: 0, updated_at: now },
      });
      log.info({ tenantId: tenant.id, usedBytes }, 'Disk quota resolved — cleared disk_quota_exceeded flag');
    }
  }
}

/**
 * Checks host-level /data mount usage.
 * >80%: logs warning
 * >95%: sets all ACTIVE tenants to UNHEALTHY
 */
export async function checkHostDisk(
  prisma: PrismaClient,
  dataMount: string,
  log: DiskQuotaLog,
  execFn: ExecFileFn = defaultExecFileFn,
): Promise<void> {
  try {
    const result = await execFn('df', ['-B1', '--output=pcent', dataMount]);
    const lines = result.stdout.trim().split('\n');
    // Second line is the value, e.g. " 85%"
    const pct = parseInt(lines[1]?.trim().replace('%', '') ?? '0', 10);
    const ratio = pct / 100;

    if (ratio > HOST_UNHEALTHY_THRESHOLD) {
      log.warn({ mount: dataMount, pct }, 'Host disk >95% full — setting all ACTIVE tenants to UNHEALTHY');
      await prisma.tenant.updateMany({
        where: { status: TenantStatus.ACTIVE, deleted_at: null },
        data: { status: TenantStatus.UNHEALTHY, updated_at: Date.now() },
      });
    } else if (ratio > HOST_WARN_THRESHOLD) {
      log.warn({ mount: dataMount, pct }, 'Host disk >80% full');
    }
  } catch (err) {
    log.error({ err, dataMount }, 'Failed to check host disk usage');
  }
}

async function sendSlackDm(
  userId: string,
  text: string,
  token: string,
  fetchFn: typeof fetch,
): Promise<void> {
  try {
    const openRes = await fetchFn('https://slack.com/api/conversations.open', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ users: userId }),
    });
    const openBody = await openRes.json() as { ok: boolean; channel?: { id: string } };
    if (!openBody.ok || !openBody.channel?.id) return;

    await fetchFn('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel: openBody.channel.id, text }),
    });
  } catch {
    // best-effort
  }
}

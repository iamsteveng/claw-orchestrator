import type { PrismaClient } from '@prisma/client';
import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import path from 'node:path';
import { MessageStatus } from '@claw/shared-types';

export type ReaperLog = {
  debug: (ctx: object, msg: string) => void;
  info: (ctx: object, msg: string) => void;
  warn: (ctx: object, msg: string) => void;
  error: (ctx: object, msg: string) => void;
};

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const AUDIT_LOG_ARCHIVE_THRESHOLD = 100_000;

/**
 * Deletes DELIVERED message_queue rows older than 7 days
 * and FAILED rows older than 30 days.
 * Runs in a SQLite transaction.
 */
export async function reapMessageQueue(
  prisma: PrismaClient,
  log: ReaperLog,
): Promise<void> {
  const now = Date.now();
  const deliveredCutoff = now - SEVEN_DAYS_MS;
  const failedCutoff = now - THIRTY_DAYS_MS;

  const [deliveredResult, failedResult] = await prisma.$transaction([
    prisma.messageQueue.deleteMany({
      where: {
        status: MessageStatus.DELIVERED,
        created_at: { lt: deliveredCutoff },
      },
    }),
    prisma.messageQueue.deleteMany({
      where: {
        status: MessageStatus.FAILED,
        created_at: { lt: failedCutoff },
      },
    }),
  ]);

  log.debug(
    { deliveredDeleted: deliveredResult.count, failedDeleted: failedResult.count },
    'Message queue reaping complete',
  );
}

/**
 * Deletes startup_locks WHERE expires_at < now.
 * Runs on every scheduler tick.
 */
export async function sweepStaleLocks(
  prisma: PrismaClient,
  log: ReaperLog,
): Promise<void> {
  const now = Date.now();
  const result = await prisma.startupLock.deleteMany({
    where: { expires_at: { lt: now } },
  });
  log.debug({ staleLockCount: result.count }, 'Stale lock sweep complete');
}

/**
 * Removes /data/tenants-archive/<id>/ directories older than 30 days.
 */
export async function cleanArchiveDirectories(
  dataMount: string,
  log: ReaperLog,
): Promise<void> {
  const archiveDir = path.join(dataMount, 'tenants-archive');
  let entries: string[];
  try {
    entries = await fs.readdir(archiveDir);
  } catch {
    // archive dir doesn't exist yet — nothing to clean
    return;
  }

  const cutoff = Date.now() - THIRTY_DAYS_MS;
  let removed = 0;

  for (const entry of entries) {
    const entryPath = path.join(archiveDir, entry);
    try {
      const stat = await fs.stat(entryPath);
      if (stat.mtimeMs < cutoff) {
        await fs.rm(entryPath, { recursive: true, force: true });
        removed++;
      }
    } catch (err) {
      log.warn({ entryPath, err }, 'Failed to check/remove archive directory');
    }
  }

  log.debug({ removed }, 'Archive directory cleanup complete');
}

/**
 * When audit_log exceeds 100,000 rows, exports rows older than 90 days to
 * /data/audit-archive/audit-YYYY-MM.ndjson.gz and deletes them from DB.
 */
export async function archiveAuditLog(
  prisma: PrismaClient,
  dataMount: string,
  log: ReaperLog,
): Promise<void> {
  const count = await prisma.auditLog.count();
  if (count < AUDIT_LOG_ARCHIVE_THRESHOLD) {
    return;
  }

  const cutoff = Date.now() - NINETY_DAYS_MS;
  const rows = await prisma.auditLog.findMany({
    where: { created_at: { lt: cutoff } },
    orderBy: { created_at: 'asc' },
  });

  if (rows.length === 0) {
    return;
  }

  // Group rows by YYYY-MM based on created_at
  const byMonth = new Map<string, typeof rows>();
  for (const row of rows) {
    const d = new Date(row.created_at);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key)!.push(row);
  }

  const archiveDir = path.join(dataMount, 'audit-archive');
  await fs.mkdir(archiveDir, { recursive: true });

  for (const [month, monthRows] of byMonth) {
    const filePath = path.join(archiveDir, `audit-${month}.ndjson.gz`);
    await writeNdjsonGz(filePath, monthRows);
    log.debug({ month, count: monthRows.length }, 'Audit log archived');
  }

  // Delete all archived rows in a transaction
  const ids = rows.map((r: { id: string }) => r.id);
  await prisma.$transaction([
    prisma.auditLog.deleteMany({ where: { id: { in: ids } } }),
  ]);

  log.debug({ archivedCount: rows.length }, 'Audit log archive complete');
}

async function writeNdjsonGz(
  filePath: string,
  rows: Array<{ id: string; tenant_id: string | null; event_type: string; actor: string; metadata: string | null; created_at: number }>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(filePath, { flags: 'a' });
    const gzip = createGzip();
    gzip.pipe(output);

    gzip.on('error', reject);
    output.on('error', reject);
    output.on('finish', resolve);

    for (const row of rows) {
      gzip.write(JSON.stringify(row) + '\n');
    }
    gzip.end();
  });
}

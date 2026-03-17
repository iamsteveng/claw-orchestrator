import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reapMessageQueue, sweepStaleLocks, cleanArchiveDirectories } from './reaper.js';
import { MessageStatus } from '@claw/shared-types';

// Minimal logger stub
const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// Prisma mock factory
function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    messageQueue: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    startupLock: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn(async (ops: Array<Promise<{ count: number }>>) => Promise.all(ops)),
    ...overrides,
  } as unknown as import('@prisma/client').PrismaClient;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reapMessageQueue', () => {
  it('deletes DELIVERED rows older than 7 days', async () => {
    const prisma = makePrisma();
    (prisma.messageQueue.deleteMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ count: 3 })
      .mockResolvedValueOnce({ count: 1 });

    await reapMessageQueue(prisma, log);

    const calls = (prisma.messageQueue.deleteMany as ReturnType<typeof vi.fn>).mock.calls as Array<[{ where: { status: string; created_at: { lt: number } } }]>;
    const deliveredCall = calls.find((c) => c[0].where.status === MessageStatus.DELIVERED);
    expect(deliveredCall).toBeDefined();
    const deliveredCutoff = deliveredCall![0].where.created_at.lt;
    expect(deliveredCutoff).toBeLessThanOrEqual(Date.now() - 7 * 24 * 60 * 60 * 1000);
  });

  it('deletes FAILED rows older than 30 days', async () => {
    const prisma = makePrisma();
    (prisma.messageQueue.deleteMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 5 });

    await reapMessageQueue(prisma, log);

    const calls = (prisma.messageQueue.deleteMany as ReturnType<typeof vi.fn>).mock.calls as Array<[{ where: { status: string; created_at: { lt: number } } }]>;
    const failedCall = calls.find((c) => c[0].where.status === MessageStatus.FAILED);
    expect(failedCall).toBeDefined();
    const failedCutoff = failedCall![0].where.created_at.lt;
    expect(failedCutoff).toBeLessThanOrEqual(Date.now() - 30 * 24 * 60 * 60 * 1000);
  });

  it('logs count of deleted rows at debug level', async () => {
    const prisma = makePrisma();
    (prisma.messageQueue.deleteMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 4 });

    await reapMessageQueue(prisma, log);

    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ deliveredDeleted: 2, failedDeleted: 4 }),
      expect.any(String),
    );
  });
});

describe('sweepStaleLocks', () => {
  it('deletes startup_locks where expires_at < now', async () => {
    const prisma = makePrisma();
    (prisma.startupLock.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });

    await sweepStaleLocks(prisma, log);

    const calls = (prisma.startupLock.deleteMany as ReturnType<typeof vi.fn>).mock.calls as Array<[{ where: { expires_at: { lt: number } } }]>;
    const [call] = calls;
    expect(call[0].where.expires_at.lt).toBeLessThanOrEqual(Date.now());
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ staleLockCount: 2 }),
      expect.any(String),
    );
  });
});

describe('cleanArchiveDirectories', () => {
  it('does nothing when archive dir does not exist', async () => {
    // Should not throw
    await expect(
      cleanArchiveDirectories('/nonexistent/path/xyz', log),
    ).resolves.toBeUndefined();
  });
});

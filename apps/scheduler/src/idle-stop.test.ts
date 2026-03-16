import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stopIdleTenants } from './idle-stop.js';
import type { PrismaClient } from '@prisma/client';

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makePrisma(tenants: { id: string; last_activity_at: number | null }[]) {
  return {
    tenant: {
      findMany: vi.fn().mockResolvedValue(tenants),
    },
  } as unknown as PrismaClient;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('stopIdleTenants', () => {
  it('calls stop for each tenant whose last_activity_at is before threshold', async () => {
    const now = Date.now();
    const idleMs = 48 * 60 * 60 * 1000; // 48h
    const stoppedIds: string[] = [];

    const tenants = [
      { id: 'tenant-1', last_activity_at: now - idleMs - 1000 }, // idle
      { id: 'tenant-2', last_activity_at: now - idleMs - 5000 }, // idle
    ];

    const fetchFn = vi.fn().mockImplementation((url: string) => {
      const match = /\/v1\/tenants\/([^/]+)\/stop/.exec(String(url));
      if (match) stoppedIds.push(match[1]);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    await stopIdleTenants(makePrisma(tenants), 'http://cp:3200', idleMs, log, fetchFn);

    expect(stoppedIds).toContain('tenant-1');
    expect(stoppedIds).toContain('tenant-2');
    expect(stoppedIds).toHaveLength(2);
  });

  it('queries DB with correct WHERE clause (status=ACTIVE, deleted_at=null, last_activity_at < threshold)', async () => {
    const now = Date.now();
    const idleMs = 48 * 60 * 60 * 1000;
    const prisma = makePrisma([]);
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 200 })) as unknown as typeof fetch;

    await stopIdleTenants(prisma, 'http://cp:3200', idleMs, log, fetchFn);

    const findManyCall = (prisma.tenant.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(findManyCall.where.status).toBe('ACTIVE');
    expect(findManyCall.where.deleted_at).toBe(null);
    // threshold check: last_activity_at.lt should be roughly (now - idleMs)
    expect(findManyCall.where.last_activity_at.lt).toBeLessThanOrEqual(Date.now());
    expect(findManyCall.where.last_activity_at.lt).toBeGreaterThan(now - idleMs - 1000);
  });

  it('logs each idle stop with tenantId and idleDurationMs', async () => {
    const now = Date.now();
    const idleMs = 1000;

    const tenants = [{ id: 'tenant-x', last_activity_at: now - 2000 }];
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 200 })) as unknown as typeof fetch;

    await stopIdleTenants(makePrisma(tenants), 'http://cp:3200', idleMs, log, fetchFn);

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-x', idleDurationMs: expect.any(Number) }),
      'Idle tenant stopped by scheduler',
    );
  });

  it('does nothing when no tenants are idle', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    await stopIdleTenants(makePrisma([]), 'http://cp:3200', 1000, log, fetchFn);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('continues if one stop call fails', async () => {
    const tenants = [
      { id: 'tenant-a', last_activity_at: 0 },
      { id: 'tenant-b', last_activity_at: 0 },
    ];
    let bStopped = false;

    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('tenant-a')) {
        return Promise.reject(new Error('network error'));
      }
      bStopped = true;
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    await stopIdleTenants(makePrisma(tenants), 'http://cp:3200', 1, log, fetchFn);

    expect(bStopped).toBe(true);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a' }),
      'Error stopping idle tenant',
    );
  });
});

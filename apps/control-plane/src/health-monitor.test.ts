import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { monitorTenantHealth } from './health-monitor.js';

// Minimal mock Prisma
function makePrisma(overrides: { recovery_attempted_at?: number | null } = {}) {
  const tenantRow = { id: 'tenant-1', recovery_attempted_at: overrides.recovery_attempted_at ?? null };
  return {
    tenant: {
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(tenantRow),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  } as unknown as import('@prisma/client').PrismaClient;
}

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const notifyUser = vi.fn().mockResolvedValue(undefined);
const replayMessages = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('monitorTenantHealth', () => {
  it('transitions to UNHEALTHY after 3 consecutive health check failures', async () => {
    const prisma = makePrisma();

    // Always fail — health endpoint returns non-200
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    // Mock docker-client import so recovery attempt doesn't fail
    vi.mock('@claw/docker-client', () => ({
      DockerClient: { start: vi.fn().mockResolvedValue(undefined) },
    }));

    vi.useFakeTimers();

    const promise = monitorTenantHealth(
      prisma,
      'tenant-1',
      'claw-tenant-abc',
      'U123',
      notifyUser,
      replayMessages,
      log,
    );

    await vi.runAllTimersAsync();
    await promise;

    // Should have set status=UNHEALTHY
    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tenant-1' },
        data: expect.objectContaining({ status: 'UNHEALTHY' }),
      }),
    );

    // Should have written TENANT_UNHEALTHY audit event
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ event_type: 'TENANT_UNHEALTHY' }),
      }),
    );

    // Should have notified user about the issue
    expect(notifyUser).toHaveBeenCalledWith(
      'U123',
      expect.stringContaining('experiencing issues'),
    );
  });

  it('recovery success path: sets ACTIVE and writes TENANT_RECOVERED, replays messages', async () => {
    const prisma = makePrisma();

    let callCount = 0;
    // Fail 3 times (trigger UNHEALTHY), then succeed (trigger recovery success)
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 3) {
        return Promise.resolve({ ok: false });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ ok: true }),
      });
    }));

    vi.mock('@claw/docker-client', () => ({
      DockerClient: { start: vi.fn().mockResolvedValue(undefined) },
    }));

    vi.useFakeTimers();

    const promise = monitorTenantHealth(
      prisma,
      'tenant-1',
      'claw-tenant-abc',
      'U123',
      notifyUser,
      replayMessages,
      log,
    );

    await vi.runAllTimersAsync();
    await promise;

    // Should have written TENANT_RECOVERED
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ event_type: 'TENANT_RECOVERED' }),
      }),
    );

    // Should have replayed queued messages
    expect(replayMessages).toHaveBeenCalledWith('tenant-1');

    // Should NOT notify user of failure
    expect(notifyUser).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('unable to recover'),
    );
  });

  it('recovery failure path: stays UNHEALTHY and notifies user of failure', async () => {
    const prisma = makePrisma();

    // Always fail — triggers UNHEALTHY then recovery fails too
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    vi.mock('@claw/docker-client', () => ({
      DockerClient: { start: vi.fn().mockResolvedValue(undefined) },
    }));

    vi.useFakeTimers();

    const promise = monitorTenantHealth(
      prisma,
      'tenant-1',
      'claw-tenant-abc',
      'U123',
      notifyUser,
      replayMessages,
      log,
    );

    await vi.runAllTimersAsync();
    await promise;

    // TENANT_RECOVERED should NOT be written
    const auditCalls = (prisma.auditLog.create as ReturnType<typeof vi.fn>).mock.calls;
    const recoveredCall = auditCalls.find(
      (call) => call[0]?.data?.event_type === 'TENANT_RECOVERED',
    );
    expect(recoveredCall).toBeUndefined();

    // Should NOT replay messages
    expect(replayMessages).not.toHaveBeenCalled();

    // Should notify user of failure
    expect(notifyUser).toHaveBeenCalledWith(
      'U123',
      expect.stringContaining('unable to recover'),
    );
  });
});

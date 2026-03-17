/**
 * Tests for US-025: Message queuing and ordered replay when tenant is stopped or starting.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  enqueueMessage,
  waitForTenantActive,
  deliverPendingMessages,
  resetStuckProcessingRows,
} from './event-handler.js';
import type { PrismaClient } from '@prisma/client';

// ─── Mock factory ─────────────────────────────────────────────────────────────

type MockMessageQueue = {
  id: string;
  tenant_id: string;
  slack_event_id: string;
  payload: string;
  status: string;
  attempts: number;
  created_at: number;
  updated_at: number;
  error?: string | null;
};

function makePrisma(opts: {
  tenantStatus?: string;
  messages?: MockMessageQueue[];
} = {}) {
  const tenantRow = opts.tenantStatus
    ? { id: 'tenant-1', status: opts.tenantStatus, relay_token: 'tok123' }
    : null;

  const messages: MockMessageQueue[] = opts.messages ?? [];
  const createdMessages: MockMessageQueue[] = [];
  const updatedMessages: Record<string, MockMessageQueue> = {};

  return {
    tenant: {
      findUnique: vi.fn().mockResolvedValue(tenantRow),
    },
    messageQueue: {
      create: vi.fn().mockImplementation((args: { data: MockMessageQueue }) => {
        createdMessages.push(args.data);
        return Promise.resolve(args.data);
      }),
      findMany: vi.fn().mockResolvedValue(messages),
      update: vi.fn().mockImplementation((args: { where: { id: string }; data: Partial<MockMessageQueue> }) => {
        updatedMessages[args.where.id] = {
          ...messages.find((m) => m.id === args.where.id),
          ...args.data,
        } as MockMessageQueue;
        return Promise.resolve(updatedMessages[args.where.id]);
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    _createdMessages: createdMessages,
    _updatedMessages: updatedMessages,
  } as unknown as PrismaClient & {
    _createdMessages: MockMessageQueue[];
    _updatedMessages: Record<string, MockMessageQueue>;
  };
}

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => vi.clearAllMocks());

// ─── enqueueMessage ───────────────────────────────────────────────────────────

describe('enqueueMessage', () => {
  it('inserts a PENDING row and returns true', async () => {
    const prisma = makePrisma();
    const result = await enqueueMessage(prisma, 'tenant-1', 'Ev001', '{"type":"event"}');
    expect(result).toBe(true);
    expect(prisma.messageQueue.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenant_id: 'tenant-1',
          slack_event_id: 'Ev001',
          status: 'PENDING',
          attempts: 0,
        }),
      }),
    );
  });

  it('returns false on duplicate slack_event_id (silently ignores)', async () => {
    const prisma = makePrisma();
    (prisma.messageQueue.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Unique constraint violated'),
    );
    const result = await enqueueMessage(prisma, 'tenant-1', 'Ev001-dup', '{}');
    expect(result).toBe(false);
  });
});

// ─── waitForTenantActive ──────────────────────────────────────────────────────

describe('waitForTenantActive', () => {
  it('returns true immediately if tenant is already ACTIVE', async () => {
    const prisma = makePrisma({ tenantStatus: 'ACTIVE' });
    const result = await waitForTenantActive(prisma, 'tenant-1', 5000);
    expect(result).toBe(true);
  });

  it('returns false if tenant never becomes ACTIVE', async () => {
    const prisma = makePrisma({ tenantStatus: 'STOPPED' });
    // Use very short timeout to not slow the test
    const result = await waitForTenantActive(prisma, 'tenant-1', 10);
    expect(result).toBe(false);
  });

  it('polls until ACTIVE (status changes on 2nd poll)', async () => {
    let callCount = 0;
    const prisma = makePrisma();
    (prisma.tenant.findUnique as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      return Promise.resolve({ status: callCount >= 2 ? 'ACTIVE' : 'STARTING' });
    });

    const result = await waitForTenantActive(prisma, 'tenant-1', 30000);
    expect(result).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

// ─── deliverPendingMessages ───────────────────────────────────────────────────

describe('deliverPendingMessages', () => {
  it('delivers 3 messages in created_at order (integration-style test)', async () => {
    const now = Date.now();
    const messages: MockMessageQueue[] = [
      { id: 'm1', tenant_id: 'tenant-1', slack_event_id: 'Ev001', payload: '{"n":1}', status: 'PENDING', attempts: 0, created_at: now, updated_at: now },
      { id: 'm2', tenant_id: 'tenant-1', slack_event_id: 'Ev002', payload: '{"n":2}', status: 'PENDING', attempts: 0, created_at: now + 1, updated_at: now },
      { id: 'm3', tenant_id: 'tenant-1', slack_event_id: 'Ev003', payload: '{"n":3}', status: 'PENDING', attempts: 0, created_at: now + 2, updated_at: now },
    ];

    const prisma = makePrisma({ messages });
    const deliveryOrder: string[] = [];

    const fetchFn = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      const body = JSON.parse(opts.body as string) as { n: number };
      deliveryOrder.push(`m${body.n}`);
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }) as unknown as typeof fetch;

    await deliverPendingMessages(prisma, 'tenant-1', 'tok123', log, fetchFn);

    // All 3 delivered in order
    expect(deliveryOrder).toEqual(['m1', 'm2', 'm3']);

    // All 3 marked DELIVERED
    expect(prisma.messageQueue.update).toHaveBeenCalledTimes(6); // 3 PROCESSING + 3 DELIVERED
    const updateCalls = (prisma.messageQueue.update as ReturnType<typeof vi.fn>).mock.calls;
    const deliveredCalls = updateCalls.filter(
      (c: unknown[]) => (c[0] as { data: { status: string } }).data.status === 'DELIVERED',
    );
    expect(deliveredCalls).toHaveLength(3);
  });

  it('marks message as FAILED after 3 failed attempts', async () => {
    const now = Date.now();
    const messages: MockMessageQueue[] = [
      { id: 'm1', tenant_id: 'tenant-1', slack_event_id: 'Ev001', payload: '{}', status: 'PENDING', attempts: 2, created_at: now, updated_at: now },
    ];

    const prisma = makePrisma({ messages });
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false }), { status: 200 }),
    ) as unknown as typeof fetch;

    await deliverPendingMessages(prisma, 'tenant-1', 'tok123', log, fetchFn);

    const updateCalls = (prisma.messageQueue.update as ReturnType<typeof vi.fn>).mock.calls;
    const failedCall = updateCalls.find(
      (c: unknown[]) => (c[0] as { data: { status: string } }).data.status === 'FAILED',
    );
    expect(failedCall).toBeDefined();
  });

  it('resets message to PENDING (not FAILED) if attempts < 3', async () => {
    const now = Date.now();
    const messages: MockMessageQueue[] = [
      { id: 'm1', tenant_id: 'tenant-1', slack_event_id: 'Ev001', payload: '{}', status: 'PENDING', attempts: 0, created_at: now, updated_at: now },
    ];

    const prisma = makePrisma({ messages });
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false }), { status: 500 }),
    ) as unknown as typeof fetch;

    await deliverPendingMessages(prisma, 'tenant-1', 'tok123', log, fetchFn);

    const updateCalls = (prisma.messageQueue.update as ReturnType<typeof vi.fn>).mock.calls;
    const pendingCall = updateCalls.find(
      (c: unknown[]) => (c[0] as { data: { status: string } }).data.status === 'PENDING',
    );
    expect(pendingCall).toBeDefined();
  });
});

// ─── resetStuckProcessingRows ─────────────────────────────────────────────────

describe('resetStuckProcessingRows', () => {
  it('resets PROCESSING rows older than 2 minutes to PENDING', async () => {
    const prisma = makePrisma();
    await resetStuckProcessingRows(prisma);

    expect(prisma.messageQueue.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'PROCESSING' }),
        data: expect.objectContaining({ status: 'PENDING' }),
      }),
    );
  });
});

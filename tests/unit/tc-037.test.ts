import { describe, it, expect, vi } from 'vitest';
import { makeTenant, makeMessageQueueRow, mockPrismaClient, mockDockerClient } from '../../packages/test-utils/src/index.js';
import { TenantStatus, MessageStatus } from '@claw/shared-types';

describe('TC-037 Workspace template fixtures → test-utils package', () => {
  it('TC-037: makeTenant() returns a fully-populated Tenant fixture', () => {
    const tenant = makeTenant();

    expect(tenant.id).toBeDefined();
    expect(typeof tenant.id).toBe('string');
    expect(tenant.principal).toBeDefined();
    expect(tenant.slack_team_id).toBeDefined();
    expect(tenant.slack_user_id).toBeDefined();
    expect(tenant.status).toBeDefined();
    expect(Object.values(TenantStatus)).toContain(tenant.status);
    expect(tenant.relay_token).toBeDefined();
    expect(tenant.container_name).toBeDefined();
    expect(tenant.image_tag).toBeDefined();
    expect(tenant.data_dir).toBeDefined();
    expect(typeof tenant.last_activity_at).toBe('number');
    expect(typeof tenant.created_at).toBe('number');
    expect(typeof tenant.updated_at).toBe('number');
  });

  it('TC-037: makeTenant() applies overrides correctly', () => {
    const tenant = makeTenant({ status: TenantStatus.STOPPED, id: 'custom-id' });

    expect(tenant.status).toBe(TenantStatus.STOPPED);
    expect(tenant.id).toBe('custom-id');
  });

  it('TC-037: makeMessageQueueRow() returns a fully-populated MessageQueueRow fixture', () => {
    const row = makeMessageQueueRow();

    expect(row.id).toBeDefined();
    expect(typeof row.id).toBe('string');
    expect(row.tenant_id).toBeDefined();
    expect(row.slack_event_id).toBeDefined();
    expect(row.payload).toBeDefined();
    expect(row.status).toBeDefined();
    expect(Object.values(MessageStatus)).toContain(row.status);
    expect(typeof row.attempts).toBe('number');
    expect(typeof row.created_at).toBe('number');
    expect(typeof row.updated_at).toBe('number');
  });

  it('TC-037: makeMessageQueueRow() applies overrides correctly', () => {
    const row = makeMessageQueueRow({ status: MessageStatus.DELIVERED, id: 'msg-custom' });

    expect(row.status).toBe(MessageStatus.DELIVERED);
    expect(row.id).toBe('msg-custom');
  });

  it('TC-037: mockPrismaClient() returns an object with vi.fn() mocks for all DB methods', () => {
    const prisma = mockPrismaClient();

    // Check tenant model methods are vi.fn() mocks
    expect(vi.isMockFunction(prisma.tenant.findUnique)).toBe(true);
    expect(vi.isMockFunction(prisma.tenant.findFirst)).toBe(true);
    expect(vi.isMockFunction(prisma.tenant.findMany)).toBe(true);
    expect(vi.isMockFunction(prisma.tenant.create)).toBe(true);
    expect(vi.isMockFunction(prisma.tenant.update)).toBe(true);
    expect(vi.isMockFunction(prisma.tenant.delete)).toBe(true);
    expect(vi.isMockFunction(prisma.tenant.upsert)).toBe(true);

    // Check messageQueue model methods are vi.fn() mocks
    expect(vi.isMockFunction(prisma.messageQueue.findUnique)).toBe(true);
    expect(vi.isMockFunction(prisma.messageQueue.create)).toBe(true);
    expect(vi.isMockFunction(prisma.messageQueue.update)).toBe(true);

    // Check $transaction and connection methods
    expect(vi.isMockFunction(prisma.$transaction)).toBe(true);
    expect(vi.isMockFunction(prisma.$connect)).toBe(true);
    expect(vi.isMockFunction(prisma.$disconnect)).toBe(true);
  });

  it('TC-037: mockDockerClient() returns an object with vi.fn() mocks for run, start, stop, rm', () => {
    const docker = mockDockerClient();

    expect(vi.isMockFunction(docker.run)).toBe(true);
    expect(vi.isMockFunction(docker.start)).toBe(true);
    expect(vi.isMockFunction(docker.stop)).toBe(true);
    expect(vi.isMockFunction(docker.rm)).toBe(true);
  });
});

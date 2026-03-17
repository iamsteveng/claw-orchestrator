import { Tenant, TenantStatus, MessageQueueRow, MessageStatus } from '@claw/shared-types';

const now = Date.now();

export function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 'a1b2c3d4e5f6a7b8',
    principal: 'T123:U456',
    slack_team_id: 'T123',
    slack_user_id: 'U456',
    status: TenantStatus.ACTIVE,
    relay_token: 'test-relay-token',
    container_name: 'claw-tenant-a1b2c3d4e5f6a7b8',
    image_tag: 'sha-abc1234',
    data_dir: '/data/tenants/a1b2c3d4e5f6a7b8',
    last_activity_at: now,
    last_started_at: now - 1000,
    last_stopped_at: null,
    provisioned_at: now - 2000,
    provision_attempts: 0,
    resource_overrides: null,
    disk_quota_exceeded: 0,
    allowlist_entry_id: 'allowlist-1',
    created_at: now - 3000,
    updated_at: now,
    deleted_at: null,
    deletion_requested_at: null,
    error_message: null,
    ...overrides,
  };
}

export function makeMessageQueueRow(overrides: Partial<MessageQueueRow> = {}): MessageQueueRow {
  return {
    id: 'msg-1',
    tenant_id: 'a1b2c3d4e5f6a7b8',
    slack_event_id: 'Ev123456',
    payload: JSON.stringify({ text: 'hello', userId: 'U456', teamId: 'T123' }),
    status: MessageStatus.PENDING,
    attempts: 0,
    created_at: now,
    updated_at: now,
    deliver_after: null,
    error: null,
    ...overrides,
  };
}

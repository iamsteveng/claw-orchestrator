export enum TenantStatus {
  NEW = 'NEW',
  PROVISIONING = 'PROVISIONING',
  STARTING = 'STARTING',
  ACTIVE = 'ACTIVE',
  STOPPED = 'STOPPED',
  UNHEALTHY = 'UNHEALTHY',
  FAILED = 'FAILED',
  DELETING = 'DELETING',
}

export interface Tenant {
  id: string;
  principal: string;
  slack_team_id: string;
  slack_user_id: string;
  status: TenantStatus;
  relay_token: string;
  container_name: string | null;
  image_tag: string | null;
  data_dir: string;
  last_activity_at: number | null;
  last_started_at: number | null;
  last_stopped_at: number | null;
  provisioned_at: number | null;
  provision_attempts: number;
  resource_overrides: string | null;
  disk_quota_exceeded: number;
  allowlist_entry_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  deletion_requested_at: number | null;
  error_message: string | null;
}

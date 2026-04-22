import { z } from 'zod';

export const controlPlaneConfigSchema = z.object({
  CONTROL_PLANE_PORT: z.coerce.number().int().positive().default(3200),
  DATABASE_URL: z.string().min(1),
  DATA_DIR: z.string().min(1),
  // HOST_DATA_DIR: the path to the data directory as seen by the Docker host.
  // When the control plane runs inside a container, DATA_DIR is the in-container path
  // (e.g. /data/tenants) but docker run resolves volume mounts using HOST paths.
  // Set HOST_DATA_DIR to the actual host path (e.g. /home/ubuntu/data/tenants) when
  // they differ. Defaults to DATA_DIR when not set.
  HOST_DATA_DIR: z.preprocess(v => v === '' ? undefined : v, z.string().min(1).optional()),
  // CONTAINER_NETWORK: Docker network to attach tenant containers to.
  // Required when the control plane runs inside Docker Compose so tenant
  // containers can reach the control plane (same network) for health checks.
  CONTAINER_NETWORK: z.preprocess(v => v === '' ? undefined : v, z.string().min(1).optional()),
  TENANT_IMAGE: z.string().min(1),
  TEMPLATES_DIR: z.string().min(1).default('/opt/claw-orchestrator/templates/workspace'),
  OPENCLAW_CONFIG_TEMPLATE: z.string().min(1).default('/opt/claw-orchestrator/docker/tenant-image/openclaw.json'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  MAX_ACTIVE_TENANTS: z.coerce.number().int().positive().default(10),
  ACTIVE_TENANTS_OVERFLOW_POLICY: z.enum(['queue', 'reject']).default('queue'),
  AWS_ACCESS_KEY_ID: z.preprocess(v => v === '' ? undefined : v, z.string().min(1).optional()),
  AWS_SECRET_ACCESS_KEY: z.preprocess(v => v === '' ? undefined : v, z.string().min(1).optional()),
  AWS_REGION: z.preprocess(v => v === '' ? undefined : v, z.string().min(1).optional()),
  AWS_SESSION_TOKEN: z.preprocess(v => v === '' ? undefined : v, z.string().min(1).optional()),
});

export type ControlPlaneConfig = z.infer<typeof controlPlaneConfigSchema>;

export const slackRelayConfigSchema = z.object({
  SLACK_RELAY_PORT: z.coerce.number().int().positive().default(3000),
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_BOT_TOKEN: z.string().min(1),
  CONTROL_PLANE_URL: z.string().url(),
});

export type SlackRelayConfig = z.infer<typeof slackRelayConfigSchema>;

export const schedulerConfigSchema = z.object({
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  IDLE_STOP_HOURS: z.coerce.number().int().positive().default(48),
  DATABASE_URL: z.string().min(1),
  CONTROL_PLANE_URL: z.string().url(),
  SLACK_BOT_TOKEN: z.string().min(1),
  DATA_MOUNT: z.string().min(1).default('/data'),
  MAX_ACTIVE_TENANTS: z.coerce.number().int().positive().default(10),
  ACTIVE_TENANTS_OVERFLOW_POLICY: z.enum(['queue', 'reject']).default('queue'),
});

export type SchedulerConfig = z.infer<typeof schedulerConfigSchema>;

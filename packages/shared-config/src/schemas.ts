import { z } from 'zod';

export const controlPlaneConfigSchema = z.object({
  CONTROL_PLANE_PORT: z.coerce.number().int().positive().default(3200),
  DATABASE_URL: z.string().min(1),
  DATA_DIR: z.string().min(1),
  TENANT_IMAGE: z.string().min(1),
  TEMPLATES_DIR: z.string().min(1).default('/opt/claw-orchestrator/templates/workspace'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  MAX_ACTIVE_TENANTS: z.coerce.number().int().positive().default(10),
  ACTIVE_TENANTS_OVERFLOW_POLICY: z.enum(['queue', 'reject']).default('queue'),
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
});

export type SchedulerConfig = z.infer<typeof schedulerConfigSchema>;

// Re-export schemas and types for use by other packages.
// Services should import their specific config directly
// (e.g. '@claw/shared-config/control-plane') so validation
// only runs for the relevant service's env vars.
export { controlPlaneConfigSchema, type ControlPlaneConfig } from './control-plane.js';
export { slackRelayConfigSchema, type SlackRelayConfig } from './slack-relay.js';
export { schedulerConfigSchema, type SchedulerConfig } from './scheduler.js';

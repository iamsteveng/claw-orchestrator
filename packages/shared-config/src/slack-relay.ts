export { slackRelayConfigSchema, type SlackRelayConfig } from './schemas.js';
import { slackRelayConfigSchema, type SlackRelayConfig } from './schemas.js';

export const slackRelayConfig: SlackRelayConfig = slackRelayConfigSchema.parse(process.env);

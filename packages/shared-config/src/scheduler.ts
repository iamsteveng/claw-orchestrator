export { schedulerConfigSchema, type SchedulerConfig } from './schemas.js';
import { schedulerConfigSchema, type SchedulerConfig } from './schemas.js';

export const schedulerConfig: SchedulerConfig = schedulerConfigSchema.parse(process.env);

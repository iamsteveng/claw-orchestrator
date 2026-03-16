export { controlPlaneConfigSchema, type ControlPlaneConfig } from './schemas.js';
import { controlPlaneConfigSchema, type ControlPlaneConfig } from './schemas.js';

export const controlPlaneConfig: ControlPlaneConfig = controlPlaneConfigSchema.parse(process.env);

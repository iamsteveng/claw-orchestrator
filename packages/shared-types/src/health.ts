/** Response from tenant container health endpoint GET /health (port 3101) */
export interface TenantHealthResponse {
  ok: boolean;
  status: 'healthy' | 'starting';
  checks: {
    openclaw: boolean;
    workspace_mounted: boolean;
    home_mounted: boolean;
  };
  uptime_ms?: number;
}

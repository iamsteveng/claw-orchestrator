/**
 * Runs a new tenant Docker container with resource limits.
 *
 * Default resource limits (can be overridden by tenant.resource_overrides JSON):
 *   --cpus=1.0
 *   --memory=1536m
 *   --memory-swap=1536m
 *   --pids-limit=256
 *   --ulimit nofile=1024:1024
 *
 * Bind mounts:
 *   - auth-profiles.json (read-only): host ~/.openclaw/agents/main/agent/auth-profiles.json
 *     → container /home/agent/.openclaw/agents/main/agent/auth-profiles.json
 *   - tenant home dir → /home/agent
 *   - tenant workspace → /workspace
 *   - tenant config dir → /home/agent/.config
 *
 * Environment variables:
 *   HOME=/home/agent
 *   XDG_CONFIG_HOME=/home/agent/.config
 *   XDG_CACHE_HOME=/home/agent/.cache
 *   XDG_STATE_HOME=/home/agent/.local/state
 *
 * Canary validation note: before promoting a new image via POST /v1/admin/images/:id/promote,
 * operators should manually start a single canary tenant with the new image, run smoke tests
 * (e.g. verify /health returns ok=true), then promote the image to roll it out lazily to all
 * tenants on their next restart. Actual canary execution is manual for MVP.
 */
export interface ResourceOverrides {
  cpus?: number;
  memory_mb?: number;
  pids_limit?: number;
}

export interface RunTenantContainerOptions {
  tenantId: string;
  dataDir: string;
  imageTag: string;
  network?: string;
  resourceOverrides?: ResourceOverrides | null;
}

export async function runTenantContainer(opts: RunTenantContainerOptions): Promise<void> {
  const { tenantId, dataDir, imageTag, network, resourceOverrides } = opts;
  const containerName = `claw-tenant-${tenantId}`;

  const overrides: ResourceOverrides = resourceOverrides ?? {};
  const cpus = (overrides.cpus ?? 1.0).toString();
  const memoryMb = overrides.memory_mb ?? 1536;
  const memory = `${memoryMb}m`;
  const pidsLimit = overrides.pids_limit ?? 256;

  // Host path for auth-profiles.json
  const homeDir = process.env.HOME ?? '/root';
  const hostAuthProfiles = `${homeDir}/.openclaw/agents/main/agent/auth-profiles.json`;
  const containerAuthProfiles = '/home/agent/.openclaw/agents/main/agent/auth-profiles.json';

  const { DockerClient } = await import('@claw/docker-client');

  await DockerClient.run({
    name: containerName,
    image: imageTag,
    cpus,
    memory,
    memorySwap: memory,
    pidsLimit,
    ulimitNofile: '1024:1024',
    network,
    volumes: [
      `${dataDir}/home:/home/agent`,
      `${dataDir}/workspace:/workspace`,
      `${dataDir}/config:/home/agent/.config`,
    ],
    readOnlyBindMounts: [
      `${hostAuthProfiles}:${containerAuthProfiles}`,
    ],
    env: [
      'HOME=/home/agent',
      'XDG_CONFIG_HOME=/home/agent/.config',
      'XDG_CACHE_HOME=/home/agent/.cache',
      'XDG_STATE_HOME=/home/agent/.local/state',
      ...(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'AWS_SESSION_TOKEN'] as const)
        .flatMap(k => process.env[k] ? [`${k}=${process.env[k]}`] : []),
    ],
  });
}

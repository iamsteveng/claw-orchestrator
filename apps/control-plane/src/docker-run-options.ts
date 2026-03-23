import type { DockerRunOptions } from '@claw/docker-client';

export interface ResourceOverrides {
  cpus?: number;
  memory_mb?: number;
  pids_limit?: number;
}

const DEFAULTS = {
  cpus: '1.0',
  memory: '3072m',
  memorySwap: '3072m',
  pidsLimit: 256,
  ulimitNofile: '1024:1024',
};

/**
 * Builds DockerRunOptions for a tenant container, applying default resource limits
 * and merging any per-tenant resource_overrides from the tenant DB row.
 */
export function buildDockerRunOptions(opts: {
  tenantId: string;
  image: string;
  dataDir: string;
  resourceOverrides?: string | null;
  relayToken?: string;
}): DockerRunOptions {
  const { tenantId, image, dataDir, resourceOverrides } = opts;

  let overrides: ResourceOverrides = {};
  if (resourceOverrides) {
    try {
      overrides = JSON.parse(resourceOverrides) as ResourceOverrides;
    } catch {
      // malformed JSON — ignore, use defaults
    }
  }

  const cpus = overrides.cpus !== undefined ? String(overrides.cpus) : DEFAULTS.cpus;
  const memory = overrides.memory_mb !== undefined ? `${overrides.memory_mb}m` : DEFAULTS.memory;
  const memorySwap = overrides.memory_mb !== undefined ? `${overrides.memory_mb}m` : DEFAULTS.memorySwap;
  const pidsLimit = overrides.pids_limit !== undefined ? overrides.pids_limit : DEFAULTS.pidsLimit;

  return {
    name: `claw-tenant-${tenantId}`,
    image,
    cpus,
    memory,
    memorySwap,
    pidsLimit,
    ulimitNofile: DEFAULTS.ulimitNofile,
    volumes: [
      `${dataDir}/home:/home/agent`,
      `${dataDir}/workspace:/workspace`,
      `${dataDir}/config:/home/agent/.config`,
    ],
    readOnlyBindMounts: [],
    env: [
      'HOME=/home/agent',
      'XDG_CONFIG_HOME=/home/agent/.config',
      'XDG_CACHE_HOME=/home/agent/.cache',
      'XDG_STATE_HOME=/home/agent/.local/state',
      ...(opts.relayToken ? [`RELAY_TOKEN=${opts.relayToken}`] : []),
    ],
  };
}

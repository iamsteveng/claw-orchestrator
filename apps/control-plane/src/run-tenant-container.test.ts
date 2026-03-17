import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runTenantContainer } from './run-tenant-container.js';

vi.mock('@claw/docker-client', () => ({
  DockerClient: {
    run: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('runTenantContainer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls dockerRun with default resource limits', async () => {
    const { DockerClient } = await import('@claw/docker-client');

    await runTenantContainer({
      tenantId: 'abc123',
      dataDir: '/data/tenants/abc123',
      imageTag: 'openclaw:latest',
    });

    expect(DockerClient.run).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'claw-tenant-abc123',
        image: 'openclaw:latest',
        cpus: '1',
        memory: '1536m',
        memorySwap: '1536m',
        pidsLimit: 256,
        ulimitNofile: '1024:1024',
      }),
    );
  });

  it('applies resource_overrides over defaults', async () => {
    const { DockerClient } = await import('@claw/docker-client');

    await runTenantContainer({
      tenantId: 'abc123',
      dataDir: '/data/tenants/abc123',
      imageTag: 'openclaw:latest',
      resourceOverrides: { cpus: 2, memory_mb: 2048, pids_limit: 512 },
    });

    expect(DockerClient.run).toHaveBeenCalledWith(
      expect.objectContaining({
        cpus: '2',
        memory: '2048m',
        memorySwap: '2048m',
        pidsLimit: 512,
      }),
    );
  });

  it('includes bind mounts for home, workspace, config, and auth-profiles', async () => {
    const { DockerClient } = await import('@claw/docker-client');

    await runTenantContainer({
      tenantId: 'abc123',
      dataDir: '/data/tenants/abc123',
      imageTag: 'openclaw:latest',
    });

    const call = vi.mocked(DockerClient.run).mock.calls[0][0];
    expect(call.volumes).toContain('/data/tenants/abc123/home:/home/agent');
    expect(call.volumes).toContain('/data/tenants/abc123/workspace:/workspace');
    expect(call.volumes).toContain('/data/tenants/abc123/config:/home/agent/.config');
    expect(call.readOnlyBindMounts?.some((m: string) => m.includes('auth-profiles.json'))).toBe(true);
  });

  it('sets required environment variables', async () => {
    const { DockerClient } = await import('@claw/docker-client');

    await runTenantContainer({
      tenantId: 'abc123',
      dataDir: '/data/tenants/abc123',
      imageTag: 'openclaw:latest',
    });

    const call = vi.mocked(DockerClient.run).mock.calls[0][0];
    expect(call.env).toContain('HOME=/home/agent');
    expect(call.env).toContain('XDG_CONFIG_HOME=/home/agent/.config');
    expect(call.env).toContain('XDG_CACHE_HOME=/home/agent/.cache');
    expect(call.env).toContain('XDG_STATE_HOME=/home/agent/.local/state');
  });
});

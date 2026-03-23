import { describe, it, expect } from 'vitest';
import { buildDockerRunOptions } from './docker-run-options.js';
import { homedir } from 'node:os';

const BASE = {
  tenantId: 'abc123',
  image: 'claw-tenant:latest',
  dataDir: '/data/tenants/abc123',
};

describe('buildDockerRunOptions', () => {
  it('sets container name to claw-tenant-<tenantId>', () => {
    const opts = buildDockerRunOptions(BASE);
    expect(opts.name).toBe('claw-tenant-abc123');
  });

  it('applies default resource limits', () => {
    const opts = buildDockerRunOptions(BASE);
    expect(opts.cpus).toBe('1.0');
    expect(opts.memory).toBe('3072m');
    expect(opts.memorySwap).toBe('3072m');
    expect(opts.pidsLimit).toBe(256);
    expect(opts.ulimitNofile).toBe('1024:1024');
  });

  it('merges resource_overrides over defaults', () => {
    const opts = buildDockerRunOptions({
      ...BASE,
      resourceOverrides: JSON.stringify({ cpus: 2.0, memory_mb: 3072, pids_limit: 512 }),
    });
    expect(opts.cpus).toBe('2');
    expect(opts.memory).toBe('3072m');
    expect(opts.memorySwap).toBe('3072m');
    expect(opts.pidsLimit).toBe(512);
    // ulimitNofile still defaults
    expect(opts.ulimitNofile).toBe('1024:1024');
  });

  it('readOnlyBindMounts is empty (auth files are copied into tenant home during provisioning)', () => {
    const opts = buildDockerRunOptions(BASE);
    expect(opts.readOnlyBindMounts).toHaveLength(0);
  });

  it('bind-mounts tenant data directories and sets env vars', () => {
    const opts = buildDockerRunOptions(BASE);
    expect(opts.volumes).toContain('/data/tenants/abc123/home:/home/agent');
    expect(opts.volumes).toContain('/data/tenants/abc123/workspace:/workspace');
    expect(opts.volumes).toContain('/data/tenants/abc123/config:/home/agent/.config');
    expect(opts.env).toContain('HOME=/home/agent');
    expect(opts.env).toContain('XDG_CONFIG_HOME=/home/agent/.config');
    expect(opts.env).toContain('XDG_CACHE_HOME=/home/agent/.cache');
    expect(opts.env).toContain('XDG_STATE_HOME=/home/agent/.local/state');
  });
});

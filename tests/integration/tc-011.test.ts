/**
 * TC-011: docker run options — auth files copied during provisioning (not bind-mounted)
 *
 * Verifies that buildDockerRunOptions returns DockerRunOptions that:
 *  - readOnlyBindMounts is empty (auth files are copied into tenant home during provisioning)
 *  - Container env includes HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, XDG_STATE_HOME
 *  - Resource flags: cpus=1.0, memory=3072m, pidsLimit=256
 */
import { describe, it, expect } from 'vitest';
import { buildDockerRunOptions } from '../../apps/control-plane/src/docker-run-options.js';

const TEST_OPTS = {
  tenantId: 'tc011-tenant',
  image: 'claw-agent:latest',
  dataDir: '/tmp/claw-tc011',
};

describe('TC-011: auth-profiles.json bind-mount → included in docker run options', () => {
  it('TC-011: readOnlyBindMounts is empty — auth files copied into tenant home during provisioning', () => {
    const result = buildDockerRunOptions(TEST_OPTS);

    expect(result.readOnlyBindMounts).toBeDefined();
    expect(Array.isArray(result.readOnlyBindMounts)).toBe(true);
    // Auth files are copied by the control plane during provisioning into ${dataDir}/home
    // They do NOT need bind mounts (which conflict with the parent /home/agent volume mount)
    expect(result.readOnlyBindMounts).toHaveLength(0);
  });

  it('TC-011: container env includes HOME and XDG_* variables', () => {
    const result = buildDockerRunOptions(TEST_OPTS);

    expect(result.env).toBeDefined();
    expect(result.env).toContain('HOME=/home/agent');
    expect(result.env).toContain('XDG_CONFIG_HOME=/home/agent/.config');
    expect(result.env).toContain('XDG_CACHE_HOME=/home/agent/.cache');
    expect(result.env).toContain('XDG_STATE_HOME=/home/agent/.local/state');
  });

  it('TC-011: resource flags — cpus=1.0, memory=3072m, pidsLimit=256', () => {
    const result = buildDockerRunOptions(TEST_OPTS);

    expect(result.cpus).toBe('1.0');
    expect(result.memory).toBe('3072m');
    expect(result.pidsLimit).toBe(256);
  });
});

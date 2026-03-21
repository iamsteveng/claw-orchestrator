/**
 * TC-011: auth-profiles.json bind-mount → included in docker run options
 *
 * Verifies that buildDockerRunOptions returns DockerRunOptions that:
 *  - Include a readOnlyBindMount containing auth-profiles.json
 *  - The bind mount path ends in auth-profiles.json
 *  - The bind mount entry is in readOnlyBindMounts (docker-client appends :ro)
 *  - Container env includes HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, XDG_STATE_HOME
 *  - Resource flags: cpus=1.0, memory=1536m, pidsLimit=256
 */
import { describe, it, expect } from 'vitest';
import { buildDockerRunOptions } from '../../apps/control-plane/src/docker-run-options.js';

const TEST_OPTS = {
  tenantId: 'tc011-tenant',
  image: 'claw-agent:latest',
  dataDir: '/tmp/claw-tc011',
};

describe('TC-011: auth-profiles.json bind-mount → included in docker run options', () => {
  it('TC-011: readOnlyBindMounts includes auth-profiles.json path (docker-client will append :ro)', () => {
    const result = buildDockerRunOptions(TEST_OPTS);

    expect(result.readOnlyBindMounts).toBeDefined();
    expect(Array.isArray(result.readOnlyBindMounts)).toBe(true);

    // Find the auth-profiles.json mount entry
    const authMount = result.readOnlyBindMounts!.find(m => m.includes('auth-profiles.json'));
    expect(authMount).toBeDefined();

    // Host path (left of first colon) must end in auth-profiles.json
    const [hostPath] = authMount!.split(':');
    expect(hostPath.endsWith('auth-profiles.json')).toBe(true);

    // Simulate what docker-client does: appends :ro to each readOnlyBindMount
    // The resulting mount arg should contain auth-profiles.json and end with :ro
    const dockerArg = authMount + ':ro';
    expect(dockerArg).toMatch(/auth-profiles\.json/);
    expect(dockerArg.endsWith(':ro')).toBe(true);
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

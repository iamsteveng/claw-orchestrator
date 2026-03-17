import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * TC-036: Docker client wrapper → correct CLI flags constructed
 *
 * The docker-client package has its own execa in packages/docker-client/node_modules/execa.
 * We must mock that path directly; mocking 'execa' from root context doesn't intercept it
 * because pnpm doesn't hoist execa to the workspace root.
 */
vi.mock('../../packages/docker-client/node_modules/execa/index.js', () => {
  const execaMock = vi.fn();
  const ExecaErrorMock = class ExecaError extends Error {
    exitCode: number | undefined;
    stderr: string;
    constructor(message: string, exitCode?: number, stderr = '') {
      super(message);
      this.name = 'ExecaError';
      this.exitCode = exitCode;
      this.stderr = stderr;
    }
  };
  return { execa: execaMock, ExecaError: ExecaErrorMock };
});

import { execa } from '../../packages/docker-client/node_modules/execa/index.js';
import { DockerClient } from '../../packages/docker-client/src/index.js';

const execaMock = vi.mocked(execa);

beforeEach(() => {
  vi.clearAllMocks();
  execaMock.mockResolvedValue({ stdout: '', stderr: '' } as never);
});

describe('TC-036 Docker client wrapper → correct CLI flags constructed', () => {
  it('TC-036: dockerRun constructs resource limit flags correctly', async () => {
    await DockerClient.run({
      name: 'claw-tenant-abc123',
      image: 'claw-tenant:latest',
      cpus: '1.0',
      memory: '1536m',
      memorySwap: '1536m',
      pidsLimit: 256,
      ulimitNofile: '1024:1024',
    });

    const args = execaMock.mock.calls[0][1] as string[];
    expect(args).toContain('--cpus');
    expect(args).toContain('1.0');
    expect(args).toContain('--memory');
    expect(args).toContain('1536m');
    expect(args).toContain('--memory-swap');
    expect(args).toContain('--pids-limit');
    expect(args).toContain('256');
    expect(args).toContain('--ulimit');
    expect(args).toContain('nofile=1024:1024');
  });

  it('TC-036: dockerRun includes --name=claw-tenant-<id> format', async () => {
    await DockerClient.run({
      name: 'claw-tenant-tenant42',
      image: 'claw-tenant:latest',
    });

    expect(execaMock).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['--name', 'claw-tenant-tenant42']),
    );
  });

  it('TC-036: dockerRun includes -d flag for detached mode', async () => {
    await DockerClient.run({
      name: 'claw-tenant-abc',
      image: 'claw-tenant:latest',
    });

    expect(execaMock).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['-d']),
    );
  });

  it('TC-036: dockerRun appends :ro suffix on readOnlyBindMounts', async () => {
    await DockerClient.run({
      name: 'claw-tenant-abc',
      image: 'claw-tenant:latest',
      readOnlyBindMounts: ['/host/auth-profiles.json:/config/auth-profiles.json'],
    });

    const args = execaMock.mock.calls[0][1] as string[];
    const volIdx = args.indexOf('-v');
    expect(volIdx).toBeGreaterThan(-1);
    expect(args[volIdx + 1]).toBe('/host/auth-profiles.json:/config/auth-profiles.json:ro');
  });

  it('TC-036: dockerStop passes --time=10 flag', async () => {
    await DockerClient.stop('claw-tenant-abc', 10);

    expect(execaMock).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['stop', '--time', '10', 'claw-tenant-abc']),
    );
  });

  it('TC-036: dockerRm passes -f flag', async () => {
    await DockerClient.rm('claw-tenant-abc');

    expect(execaMock).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['rm', '-f', 'claw-tenant-abc']),
    );
  });
});

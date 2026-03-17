import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DockerClient, DockerError } from './index.js';

// Mock execa module
vi.mock('execa', () => {
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

import { execa, ExecaError } from 'execa';
const execaMock = vi.mocked(execa);
// ExecaError constructor is not publicly typed in execa v9; cast for test instantiation
const MakeExecaError = ExecaError as unknown as new (message: string, exitCode?: number, stderr?: string) => ExecaError;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('dockerRun', () => {
  it('calls docker run with all required flags', async () => {
    execaMock.mockResolvedValue({ stdout: '', stderr: '' } as never);

    await DockerClient.run({
      name: 'claw-tenant-abc123',
      image: 'claw-tenant:sha-abc1234',
      cpus: '1.0',
      memory: '1536m',
      memorySwap: '1536m',
      pidsLimit: 256,
      ulimitNofile: '1024:1024',
      network: 'bridge',
      volumes: ['/data/tenants/abc:/workspace'],
      readOnlyBindMounts: ['/host/auth.json:/config/auth.json'],
      env: ['FOO=bar'],
    });

    expect(execaMock).toHaveBeenCalledWith('docker', expect.arrayContaining([
      'run', '-d',
      '--name', 'claw-tenant-abc123',
      '--cpus', '1.0',
      '--memory', '1536m',
      '--memory-swap', '1536m',
      '--pids-limit', '256',
      '--ulimit', 'nofile=1024:1024',
      '--network', 'bridge',
      '-v', '/data/tenants/abc:/workspace',
      '-v', '/host/auth.json:/config/auth.json:ro',
      '-e', 'FOO=bar',
      'claw-tenant:sha-abc1234',
    ]));
  });

  it('throws DockerError on failure', async () => {
    const execaErr = new MakeExecaError('docker run failed', 1, 'some error');
    execaMock.mockRejectedValue(execaErr);

    await expect(DockerClient.run({ name: 'test', image: 'img' }))
      .rejects.toBeInstanceOf(DockerError);
  });
});

describe('dockerStart', () => {
  it('calls docker start with containerName', async () => {
    execaMock.mockResolvedValue({ stdout: '', stderr: '' } as never);

    await DockerClient.start('my-container');

    expect(execaMock).toHaveBeenCalledWith('docker', ['start', 'my-container']);
  });
});

describe('dockerStop', () => {
  it('calls docker stop without timeout if not specified', async () => {
    execaMock.mockResolvedValue({ stdout: '', stderr: '' } as never);

    await DockerClient.stop('my-container');

    expect(execaMock).toHaveBeenCalledWith('docker', ['stop', 'my-container']);
  });

  it('calls docker stop --time when timeout specified', async () => {
    execaMock.mockResolvedValue({ stdout: '', stderr: '' } as never);

    await DockerClient.stop('my-container', 30);

    expect(execaMock).toHaveBeenCalledWith('docker', ['stop', '--time', '30', 'my-container']);
  });
});

describe('dockerRm', () => {
  it('calls docker rm -f with containerName', async () => {
    execaMock.mockResolvedValue({ stdout: '', stderr: '' } as never);

    await DockerClient.rm('my-container');

    expect(execaMock).toHaveBeenCalledWith('docker', ['rm', '-f', 'my-container']);
  });
});

describe('dockerInspect', () => {
  it('returns parsed JSON on success', async () => {
    const fakeResult = [{ Id: 'abc123', Name: '/my-container', State: { Status: 'running', Running: true, ExitCode: 0 } }];
    execaMock.mockResolvedValue({ stdout: JSON.stringify(fakeResult), stderr: '' } as never);

    const result = await DockerClient.inspect('my-container');

    expect(result).toEqual(fakeResult[0]);
    expect(execaMock).toHaveBeenCalledWith('docker', ['inspect', 'my-container']);
  });

  it('returns null when container not found (exit code 1)', async () => {
    const err = new MakeExecaError('not found', 1, 'Error: No such container');
    execaMock.mockRejectedValue(err);

    const result = await DockerClient.inspect('not-exists');

    expect(result).toBeNull();
  });
});

describe('dockerExec', () => {
  it('calls docker exec and returns stdout', async () => {
    execaMock.mockResolvedValue({ stdout: 'hello', stderr: '' } as never);

    const output = await DockerClient.exec('my-container', ['echo', 'hello']);

    expect(output).toBe('hello');
    expect(execaMock).toHaveBeenCalledWith('docker', ['exec', 'my-container', 'echo', 'hello']);
  });
});

describe('DockerError', () => {
  it('has exitCode, stderr, and containerName fields', () => {
    const err = new DockerError('test error', 42, 'some stderr', 'my-container');
    expect(err.exitCode).toBe(42);
    expect(err.stderr).toBe('some stderr');
    expect(err.containerName).toBe('my-container');
    expect(err.name).toBe('DockerError');
  });
});

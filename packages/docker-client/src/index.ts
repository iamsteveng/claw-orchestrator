import { execa, ExecaError } from 'execa';

// ─── Error type ───────────────────────────────────────────────────────────────

export class DockerError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | undefined,
    public readonly stderr: string,
    public readonly containerName: string,
  ) {
    super(message);
    this.name = 'DockerError';
  }
}

function toDockerError(err: unknown, containerName: string): DockerError {
  if (err instanceof ExecaError) {
    return new DockerError(
      err.message,
      typeof err.exitCode === 'number' ? err.exitCode : undefined,
      typeof err.stderr === 'string' ? err.stderr : '',
      containerName,
    );
  }
  if (err instanceof Error) {
    return new DockerError(err.message, undefined, '', containerName);
  }
  return new DockerError(String(err), undefined, '', containerName);
}

// ─── Option types ─────────────────────────────────────────────────────────────

export interface DockerRunOptions {
  name: string;
  image: string;
  cpus?: string;
  memory?: string;
  memorySwap?: string;
  pidsLimit?: number;
  ulimitNofile?: string;
  network?: string;
  volumes?: string[];
  readOnlyBindMounts?: string[];
  env?: string[];
}

export interface DockerInspectResult {
  Id: string;
  Name: string;
  State: {
    Status: string;
    Running: boolean;
    ExitCode: number;
  };
  [key: string]: unknown;
}

// ─── Docker client functions ──────────────────────────────────────────────────

async function dockerRun(options: DockerRunOptions): Promise<void> {
  const args: string[] = ['run', '-d'];
  args.push('--name', options.name);
  if (options.cpus !== undefined) args.push('--cpus', options.cpus);
  if (options.memory !== undefined) args.push('--memory', options.memory);
  if (options.memorySwap !== undefined) args.push('--memory-swap', options.memorySwap);
  if (options.pidsLimit !== undefined) args.push('--pids-limit', String(options.pidsLimit));
  if (options.ulimitNofile !== undefined) args.push('--ulimit', 'nofile=' + options.ulimitNofile);
  if (options.network !== undefined) args.push('--network', options.network);
  for (const vol of options.volumes ?? []) args.push('-v', vol);
  for (const mount of options.readOnlyBindMounts ?? []) args.push('-v', mount + ':ro');
  for (const envVar of options.env ?? []) args.push('-e', envVar);
  args.push(options.image);
  try {
    await execa('docker', args);
  } catch (err) {
    throw toDockerError(err, options.name);
  }
}

async function dockerStart(containerName: string): Promise<void> {
  try {
    await execa('docker', ['start', containerName]);
  } catch (err) {
    throw toDockerError(err, containerName);
  }
}

async function dockerStop(containerName: string, timeoutSeconds?: number): Promise<void> {
  const args = ['stop'];
  if (timeoutSeconds !== undefined) args.push('--time', String(timeoutSeconds));
  args.push(containerName);
  try {
    await execa('docker', args);
  } catch (err) {
    throw toDockerError(err, containerName);
  }
}

async function dockerRm(containerName: string): Promise<void> {
  try {
    await execa('docker', ['rm', '-f', containerName]);
  } catch (err) {
    throw toDockerError(err, containerName);
  }
}

async function dockerInspect(containerName: string): Promise<DockerInspectResult | null> {
  try {
    const result = await execa('docker', ['inspect', containerName]);
    const parsed = JSON.parse(result.stdout) as DockerInspectResult[];
    return parsed[0] ?? null;
  } catch (err) {
    if (err instanceof ExecaError && err.exitCode === 1) {
      return null;
    }
    throw toDockerError(err, containerName);
  }
}

async function dockerExec(containerName: string, command: string[]): Promise<string> {
  try {
    const result = await execa('docker', ['exec', containerName, ...command]);
    return result.stdout;
  } catch (err) {
    throw toDockerError(err, containerName);
  }
}

// ─── Exported client object ───────────────────────────────────────────────────

export const DockerClient = {
  run: dockerRun,
  start: dockerStart,
  stop: dockerStop,
  rm: dockerRm,
  inspect: dockerInspect,
  exec: dockerExec,
};

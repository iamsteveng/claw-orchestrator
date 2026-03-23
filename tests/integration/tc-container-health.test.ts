/**
 * TC-CONTAINER-HEALTH: Tenant container spawns, becomes healthy, and auth files are accessible
 *
 * Integration test verifying the full container lifecycle using the REAL docker runtime:
 * - docker run succeeds
 * - Container health endpoint returns {ok: true} within 30 seconds
 * - docker inspect shows the container is running
 * - Auth files inside the container are accessible by the agent user
 *
 * SKIPPED if claw-tenant:latest image does not exist.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, access, stat, copyFile, writeFile, chmod } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

// ─── Test state ───────────────────────────────────────────────────────────────

let imageExists = false;
let testDir: string;
let containerName: string;
let healthPort: number;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function checkImageExists(): boolean {
  try {
    execSync('docker image inspect claw-tenant:latest', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the host port mapped to a container port.
 */
function getContainerPort(name: string, containerPort: number): number {
  const out = execSync(`docker port "${name}" ${containerPort}`, { encoding: 'utf8', stdio: 'pipe' });
  // Format: "0.0.0.0:32768\n" or ":::32768\n"
  const match = out.trim().match(/:(\d+)$/);
  if (!match) throw new Error(`Could not parse port from: ${out}`);
  return parseInt(match[1], 10);
}

/**
 * Poll the container health endpoint until {ok: true} or timeout.
 */
async function pollUntilHealthy(port: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        const body = (await response.json()) as { ok: boolean };
        if (body.ok === true) return true;
      }
    } catch {
      // Connection refused / not ready yet — keep polling
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * Ensure a fixture file exists at the given path. If missing, create minimal content.
 */
const createdFixtures: string[] = [];
async function ensureFixtureExists(filePath: string, content: string): Promise<void> {
  try {
    await access(filePath, fsConstants.R_OK);
  } catch {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, { encoding: 'utf8' });
    createdFixtures.push(filePath);
  }
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  imageExists = checkImageExists();
  if (!imageExists) return;

  // Ensure auth fixture files exist on the host
  const hostHome = homedir();
  const authSrc = join(hostHome, '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
  const credsSrc = join(hostHome, '.claude', '.credentials.json');

  await ensureFixtureExists(
    authSrc,
    JSON.stringify({
      profiles: { 'anthropic:default': { provider: 'anthropic', mode: 'token', token: 'fixture-token' } },
    }, null, 2),
  );
  await ensureFixtureExists(
    credsSrc,
    JSON.stringify({ claudeAiOauthTokenExpiry: 9999999999, claudeAiOauthToken: 'fixture-oauth-token' }, null, 2),
  );

  // Create isolated temp dir (matches what provisioning would create)
  testDir = await mkdtemp(join(tmpdir(), 'claw-tc-container-health-'));

  // Create and chmod 777 so the container's agent user (uid 1001) can write
  for (const dir of [
    join(testDir, 'home'),
    join(testDir, 'home', '.openclaw'),
    join(testDir, 'home', '.openclaw', 'agents'),
    join(testDir, 'home', '.openclaw', 'agents', 'main'),
    join(testDir, 'home', '.openclaw', 'agents', 'main', 'agent'),
    join(testDir, 'home', '.openclaw', 'agents', 'main', 'sessions'),
    join(testDir, 'home', '.openclaw', 'logs'),
    join(testDir, 'home', '.openclaw', 'credentials'),
    join(testDir, 'home', '.openclaw', 'canvas'),
    join(testDir, 'home', '.openclaw', 'subagents'),
    join(testDir, 'home', '.claude'),
    join(testDir, 'workspace'),
    join(testDir, 'config'),
  ]) {
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o777);
  }

  // Copy auth files from host into tenant home
  await copyFile(authSrc, join(testDir, 'home', '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json'));
  await copyFile(credsSrc, join(testDir, 'home', '.claude', '.credentials.json'));

  // Write openclaw.json config (matches what provisioning writes)
  await writeFile(
    join(testDir, 'home', '.openclaw', 'openclaw.json'),
    JSON.stringify({
      wizard: { lastRunAt: '2026-01-01T00:00:00.000Z', lastRunVersion: '2026.3.13', lastRunMode: 'local' },
      auth: { profiles: { 'anthropic:default': { provider: 'anthropic', mode: 'token' } } },
      gateway: { port: 19001, mode: 'local', bind: 'auto' },
      agents: { defaults: { model: { primary: 'anthropic/claude-sonnet-4-6' }, workspace: '/workspace' } },
    }, null, 2),
  );

  // Unique container name
  containerName = `claw-tenant-test-${randomBytes(8).toString('hex')}`;
  const relayToken = randomBytes(32).toString('hex');

  // Run the container with the same volume mounts as the control plane would use
  execSync(
    [
      'docker run -d',
      `--name "${containerName}"`,
      '-p 0:3101',
      `-v "${testDir}/home:/home/agent"`,
      `-v "${testDir}/workspace:/workspace"`,
      `-v "${testDir}/config:/home/agent/.config"`,
      '-e HOME=/home/agent',
      '-e XDG_CONFIG_HOME=/home/agent/.config',
      '-e XDG_CACHE_HOME=/home/agent/.cache',
      '-e XDG_STATE_HOME=/home/agent/.local/state',
      `-e RELAY_TOKEN=${relayToken}`,
      'claw-tenant:latest',
    ].join(' '),
    { stdio: 'pipe' },
  );

  // Get the mapped port for health server (3101)
  healthPort = getContainerPort(containerName, 3101);
}, 60_000);

afterAll(async () => {
  if (!imageExists) return;

  // Stop and remove the container (try/finally for reliability)
  if (containerName) {
    try {
      execSync(`docker stop "${containerName}"`, { stdio: 'pipe' });
    } catch { /* best-effort */ }
    try {
      execSync(`docker rm "${containerName}"`, { stdio: 'pipe' });
    } catch { /* best-effort */ }
  }

  // Fix file ownership before removing temp dir (entrypoint chowns to agent uid 1001)
  if (testDir) {
    try {
      spawnSync('docker', ['run', '--rm', '-v', `${testDir}:/mnt`, 'alpine', 'chmod', '-R', '777', '/mnt'], {
        stdio: 'pipe',
      });
    } catch { /* best-effort */ }
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }

  // Clean up any fixture files we created
  for (const fixturePath of createdFixtures) {
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(fixturePath);
    } catch { /* best-effort */ }
  }
}, 60_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TC-CONTAINER-HEALTH: Tenant container spawns, becomes healthy, and auth files are accessible', () => {
  it('TC-CONTAINER-HEALTH: skip if claw-tenant:latest image does not exist', () => {
    if (!imageExists) {
      console.log('Skipping — claw-tenant:latest image not found');
      return;
    }
    expect(imageExists).toBe(true);
  });

  it('TC-CONTAINER-HEALTH: container starts and is running (docker ps)', async () => {
    if (!imageExists) return;

    // Container should be listed in docker ps
    const psOutput = execSync(`docker ps --filter name="${containerName}" --format "{{.Names}}"`, {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    expect(psOutput.trim()).toContain(containerName);
  });

  it('TC-CONTAINER-HEALTH: health endpoint returns {ok: true} within 30 seconds', async () => {
    if (!imageExists) return;

    const healthy = await pollUntilHealthy(healthPort, 30_000);
    expect(healthy).toBe(true);
  }, 35_000);

  it('TC-CONTAINER-HEALTH: docker inspect shows container is running (not exited)', () => {
    if (!imageExists) return;

    const inspectOut = execSync(`docker inspect "${containerName}" --format '{{.State.Running}}'`, {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    expect(inspectOut.trim()).toBe('true');
  });

  it('TC-CONTAINER-HEALTH: auth-profiles.json exists inside the container at /home/agent path', () => {
    if (!imageExists) return;

    // Use docker exec to check file exists
    const out = execSync(
      `docker exec "${containerName}" test -f /home/agent/.openclaw/agents/main/agent/auth-profiles.json && echo "exists"`,
      { encoding: 'utf8', stdio: 'pipe' },
    );
    expect(out.trim()).toBe('exists');
  });

  it('TC-CONTAINER-HEALTH: auth-profiles.json is non-empty inside the container', () => {
    if (!imageExists) return;

    const catOut = execSync(
      `docker exec "${containerName}" cat /home/agent/.openclaw/agents/main/agent/auth-profiles.json`,
      { encoding: 'utf8', stdio: 'pipe' },
    );
    expect(catOut.trim().length).toBeGreaterThan(0);
  });

  it('TC-CONTAINER-HEALTH: .credentials.json exists inside the container at /home/agent path', () => {
    if (!imageExists) return;

    const out = execSync(
      `docker exec "${containerName}" test -f /home/agent/.claude/.credentials.json && echo "exists"`,
      { encoding: 'utf8', stdio: 'pipe' },
    );
    expect(out.trim()).toBe('exists');
  });

  it('TC-CONTAINER-HEALTH: .credentials.json is non-empty inside the container', () => {
    if (!imageExists) return;

    const catOut = execSync(
      `docker exec "${containerName}" cat /home/agent/.claude/.credentials.json`,
      { encoding: 'utf8', stdio: 'pipe' },
    );
    expect(catOut.trim().length).toBeGreaterThan(0);
  });

  it('TC-CONTAINER-HEALTH: auth-profiles.json stat shows non-zero size on host', async () => {
    if (!imageExists) return;

    const authFilePath = join(testDir, 'home', '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
    const stats = await stat(authFilePath);
    expect(stats.size).toBeGreaterThan(0);
  });

  it('TC-CONTAINER-HEALTH: .credentials.json stat shows non-zero size on host', async () => {
    if (!imageExists) return;

    const credsFilePath = join(testDir, 'home', '.claude', '.credentials.json');
    const stats = await stat(credsFilePath);
    expect(stats.size).toBeGreaterThan(0);
  });
});

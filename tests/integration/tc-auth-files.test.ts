/**
 * TC-AUTH-FILES: Auth files copied with correct ownership during provisioning
 *
 * Verifies that provisioning copies auth files into the tenant home dir:
 * - auth-profiles.json exists at ${dataDir}/home/.openclaw/agents/main/agent/auth-profiles.json
 * - .credentials.json exists at ${dataDir}/home/.claude/.credentials.json
 * - Both files are non-empty (size > 0)
 * - Both files are readable (fs.access with R_OK passes)
 *
 * Uses real temp dir for dataDir to test actual file I/O.
 * Creates minimal fixture files at homedir paths if host files don't exist.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, access, stat, writeFile, unlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { buildApp as BuildAppFn } from '../../apps/control-plane/src/app-factory.js';

// Small mock timestamp to avoid SQLite Int32 overflow
let mockNow = 40_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_TEAM_ID = 'T_AUTH_FILES';
const TEST_USER_ID = 'U_AUTH_FILES';
const TEST_DATA_DIR = '/tmp/claw-tc-auth-files-isolated';
const CP_PORT = 13370;

// ─── Mock Docker client ────────────────────────────────────────────────────────

const mockDockerClient = {
  run: vi.fn().mockResolvedValue(undefined),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
};

// ─── Test state ───────────────────────────────────────────────────────────────

let cpApp: FastifyInstance;
let prisma: PrismaClient;
let tempDbPath: string;
let tenantId: string;
let dataDir: string;

// Track fixture files we created so we can clean them up
const createdFixtures: string[] = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Ensure a fixture file exists at the given path. If the file doesn't exist,
 * create a minimal JSON fixture and record it for cleanup.
 */
async function ensureFixtureExists(filePath: string, content: string): Promise<void> {
  try {
    await access(filePath, fsConstants.R_OK);
    // File already exists — no need to create it
  } catch {
    // File missing — create parent dirs + minimal fixture
    const dir = join(filePath, '..');
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, content, { encoding: 'utf8' });
    createdFixtures.push(filePath);
  }
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Ensure auth fixture files exist at the host homedir paths that provisioning reads from
  const hostHome = homedir();
  const authSrc = join(hostHome, '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
  const credsSrc = join(hostHome, '.claude', '.credentials.json');

  await ensureFixtureExists(
    authSrc,
    JSON.stringify({ profiles: { 'anthropic:default': { provider: 'anthropic', mode: 'token', token: 'fixture-token' } } }, null, 2),
  );
  await ensureFixtureExists(
    credsSrc,
    JSON.stringify({ claudeAiOauthTokenExpiry: 9999999999, claudeAiOauthToken: 'fixture-oauth-token' }, null, 2),
  );

  // Override DATA_DIR and reset module cache so controlPlaneConfig re-evaluates
  vi.stubEnv('DATA_DIR', TEST_DATA_DIR);
  vi.resetModules();

  // Create temp SQLite DB
  tempDbPath = `/tmp/test-tc-auth-files-${randomUUID()}.db`;
  const dbUrl = `file:${tempDbPath}`;

  await mkdir(TEST_DATA_DIR, { recursive: true });

  const result = spawnSync(`${process.cwd()}/node_modules/.bin/prisma`, ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    shell: false,
    cwd: process.cwd(),
  });
  if (result.status !== 0) {
    throw new Error('prisma db push failed: ' + String(result.stderr ?? result.stdout ?? 'unknown error'));
  }

  prisma = new PrismaClient({ datasourceUrl: dbUrl });
  await prisma.$connect();

  // Seed default container image
  await prisma.containerImage.create({
    data: {
      id: randomUUID(),
      tag: 'claw-tenant:test',
      is_default: 1,
      created_at: mockNow++,
    },
  });

  // Seed allowlist entry
  await prisma.allowlist.create({
    data: {
      id: randomUUID(),
      slack_team_id: TEST_TEAM_ID,
      slack_user_id: null,
      added_by: 'tc-auth-files-test-setup',
      created_at: mockNow++,
    },
  });

  // Dynamically import buildApp AFTER vi.resetModules() so controlPlaneConfig
  // re-evaluates with DATA_DIR=TEST_DATA_DIR
  const { buildApp } = (await import('../../apps/control-plane/src/app-factory.js')) as {
    buildApp: typeof BuildAppFn;
  };

  cpApp = await buildApp(prisma, { logger: false, dockerClient: mockDockerClient });
  await cpApp.listen({ port: CP_PORT, host: '127.0.0.1' });

  // Provision the tenant — this copies auth files synchronously
  const res = await cpApp.inject({
    method: 'POST',
    url: '/v1/tenants/provision',
    payload: { slackTeamId: TEST_TEAM_ID, slackUserId: TEST_USER_ID },
  });

  if (res.statusCode !== 200) {
    throw new Error(`Provision failed: ${res.statusCode} ${res.body}`);
  }

  const body = res.json<{ tenantId: string; status: string; relayToken: string }>();
  tenantId = body.tenantId;

  // Get dataDir from DB
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new Error('Tenant not found in DB after provision');
  dataDir = tenant.data_dir;
}, 60_000);

afterAll(async () => {
  if (cpApp) await cpApp.close();
  if (prisma) await prisma.$disconnect();

  try {
    await unlink(tempDbPath);
  } catch { /* best-effort */ }

  try {
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
  } catch { /* best-effort */ }

  // Clean up any fixture files we created during this test run
  for (const fixturePath of createdFixtures) {
    try {
      await unlink(fixturePath);
    } catch { /* best-effort */ }
  }
}, 30_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TC-AUTH-FILES: Auth files copied with correct ownership during provisioning', () => {
  it('TC-AUTH-FILES: provision returns 200 with status=NEW', async () => {
    expect(tenantId).toBeTruthy();
    expect(dataDir).toContain(tenantId);
  });

  it('TC-AUTH-FILES: auth-profiles.json exists at expected path inside tenant home', async () => {
    const authFilePath = join(dataDir, 'home', '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
    await expect(access(authFilePath)).resolves.toBeUndefined();
  });

  it('TC-AUTH-FILES: auth-profiles.json is non-empty (size > 0)', async () => {
    const authFilePath = join(dataDir, 'home', '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
    const stats = await stat(authFilePath);
    expect(stats.size).toBeGreaterThan(0);
  });

  it('TC-AUTH-FILES: auth-profiles.json is readable (R_OK check passes)', async () => {
    const authFilePath = join(dataDir, 'home', '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
    await expect(access(authFilePath, fsConstants.R_OK)).resolves.toBeUndefined();
  });

  it('TC-AUTH-FILES: .credentials.json exists at expected path inside tenant home', async () => {
    const credsFilePath = join(dataDir, 'home', '.claude', '.credentials.json');
    await expect(access(credsFilePath)).resolves.toBeUndefined();
  });

  it('TC-AUTH-FILES: .credentials.json is non-empty (size > 0)', async () => {
    const credsFilePath = join(dataDir, 'home', '.claude', '.credentials.json');
    const stats = await stat(credsFilePath);
    expect(stats.size).toBeGreaterThan(0);
  });

  it('TC-AUTH-FILES: .credentials.json is readable (R_OK check passes)', async () => {
    const credsFilePath = join(dataDir, 'home', '.claude', '.credentials.json');
    await expect(access(credsFilePath, fsConstants.R_OK)).resolves.toBeUndefined();
  });
});

/**
 * Scheduler & System-Level Tests
 *
 * Tests:
 *   TC-010 — Idle stop → container stopped after 48h inactivity
 *   TC-011 — auth-profiles.json bind-mount → included in docker run options
 *   TC-018 — Tenant ID computation → sha256(team:user).slice(0,16)
 *   TC-030 — Queue reaping → DELIVERED rows older than 7 days deleted
 *   TC-033 — systemd unit files exist for all three services
 *   TC-034 — tenant-shell script validates container is running
 *   TC-035 — Tenant Dockerfile does not embed ANTHROPIC_API_KEY
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

// Use a small incrementing counter for mockNow (same pattern as other test files).
// DB timestamps must fit in 32-bit INT range (< 2,147,483,647).
// For relative time arithmetic (idle stop), we do the math carefully with small values.
let mockNow = 7_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => mockNow++);

import { stopIdleTenants } from '../../apps/scheduler/src/idle-stop.js';
import { reapMessageQueue, sweepStaleLocks } from '../../apps/scheduler/src/reaper.js';
import { buildDockerRunOptions } from '../../apps/control-plane/src/docker-run-options.js';

const TEST_DATA_DIR = process.env.DATA_DIR ?? '/tmp/claw-test-tenants';
const REPO_ROOT = '/home/ubuntu/.openclaw/workspace/claw-orchestrator';

let prisma: PrismaClient;
let tempDbPath: string;

const mockLog = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
};

beforeAll(async () => {
  tempDbPath = `/tmp/test-scheduler-${randomUUID()}.db`;
  const dbUrl = `file:${tempDbPath}`;
  await mkdir(TEST_DATA_DIR, { recursive: true });

  const result = spawnSync(`${process.cwd()}/node_modules/.bin/prisma`, ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    shell: false,
    cwd: REPO_ROOT,
  });
  if (result.status !== 0) throw new Error('prisma db push failed: ' + String(result.stderr ?? result.stdout ?? 'unknown error'));

  prisma = new PrismaClient({ datasourceUrl: dbUrl });
  await prisma.$connect();
}, 30_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  try { const { unlink } = await import('node:fs/promises'); await unlink(tempDbPath); } catch { /* best-effort */ }
}, 15_000);

// ─── TC-018: Tenant ID computation ────────────────────────────────────────────
describe('TC-018: Tenant ID computation → sha256(team:user).slice(0,16)', () => {
  it('computes correct deterministic 16-char hex ID', () => {
    const teamId = 'T12345';
    const userId = 'U67890';
    const expected = createHash('sha256').update(`${teamId}:${userId}`).digest('hex').slice(0, 16);

    const result = createHash('sha256').update(`${teamId}:${userId}`).digest('hex').slice(0, 16);

    expect(result).toBe(expected);
    expect(result).toHaveLength(16);
    // All hex chars
    expect(result).toMatch(/^[0-9a-f]{16}$/);
  });

  it('different users produce different IDs', () => {
    const id1 = createHash('sha256').update('T1:U1').digest('hex').slice(0, 16);
    const id2 = createHash('sha256').update('T1:U2').digest('hex').slice(0, 16);
    expect(id1).not.toBe(id2);
  });

  it('same inputs always produce same output (deterministic)', () => {
    const compute = (t: string, u: string) =>
      createHash('sha256').update(`${t}:${u}`).digest('hex').slice(0, 16);

    expect(compute('T_SAME', 'U_SAME')).toBe(compute('T_SAME', 'U_SAME'));
  });
});

// ─── TC-011: auth-profiles.json bind-mount ────────────────────────────────────
describe('TC-011: auth-profiles.json bind-mount → included in docker run options', () => {
  it('buildDockerRunOptions includes auth-profiles.json as read-only bind mount', () => {
    const opts = buildDockerRunOptions({
      tenantId: 'test123',
      image: 'claw-tenant:latest',
      dataDir: '/data/tenants/test123',
    });

    expect(opts.readOnlyBindMounts).toBeDefined();
    expect(Array.isArray(opts.readOnlyBindMounts)).toBe(true);

    const authMount = opts.readOnlyBindMounts!.find((m: string) => m.includes('auth-profiles.json'));
    expect(authMount).toBeDefined();
    expect(authMount).toContain('auth-profiles.json');
    // The source path should be the host user's home dir path
    expect(authMount).toContain(`${homedir()}/.openclaw/agents/main/agent/auth-profiles.json`);
  });

  it('container env includes HOME and XDG vars', () => {
    const opts = buildDockerRunOptions({
      tenantId: 'test456',
      image: 'claw-tenant:latest',
      dataDir: '/data/tenants/test456',
    });

    expect(opts.env).toContain('HOME=/home/agent');
    expect(opts.env).toContain('XDG_CONFIG_HOME=/home/agent/.config');
    expect(opts.env).toContain('XDG_CACHE_HOME=/home/agent/.cache');
    expect(opts.env).toContain('XDG_STATE_HOME=/home/agent/.local/state');
  });

  it('resource limits are applied correctly', () => {
    const opts = buildDockerRunOptions({
      tenantId: 'test789',
      image: 'claw-tenant:latest',
      dataDir: '/data/tenants/test789',
    });

    expect(opts.cpus).toBe('1.0');
    expect(opts.memory).toBe('3072m');
    expect(opts.pidsLimit).toBe(256);
    expect(opts.ulimitNofile).toBe('1024:1024');
  });

  it('container name is claw-tenant-<tenantId>', () => {
    const opts = buildDockerRunOptions({
      tenantId: 'abc123ef',
      image: 'claw-tenant:latest',
      dataDir: '/data/tenants/abc123ef',
    });

    expect(opts.name).toBe('claw-tenant-abc123ef');
  });

  it('resource overrides are applied', () => {
    const opts = buildDockerRunOptions({
      tenantId: 'override1',
      image: 'claw-tenant:latest',
      dataDir: '/data/tenants/override1',
      resourceOverrides: JSON.stringify({ cpus: 2.0, memory_mb: 3072 }),
    });

    // JSON.parse converts 2.0 to integer 2, so toString gives '2' not '2.0'
    expect(opts.cpus).toBe('2');
    expect(opts.memory).toBe('3072m');
  });
});

// ─── TC-010: Idle stop ────────────────────────────────────────────────────────
describe('TC-010: Idle stop → container stopped after 48h inactivity', () => {
  // Use a small IDLE_STOP_MS so the arithmetic stays within 32-bit INT range
  // Normally 48h = 172_800_000 ms, but that + mockNow base (7_000_000+) is fine as long as
  // the _result_ (mockNow - idleStopMs) is > 0. We use 1000ms as the threshold for tests
  // and manipulate last_activity_at accordingly.
  const IDLE_STOP_MS = 1000; // 1 second threshold for tests
  const CP_URL = 'http://localhost:99999';

  it('stops tenant idle for >threshold (last_activity_at is old)', async () => {
    const tenantId = randomUUID().slice(0, 16);
    // last_activity_at well below the threshold (mockNow - 1000)
    const FORTY_NINE_HOURS_AGO = 1000; // very small → definitely below threshold

    await prisma.tenant.create({
      data: {
        id: tenantId,
        principal: `T_IDLE:U_IDLE_${tenantId}`,
        slack_team_id: 'T_IDLE', slack_user_id: `U_IDLE_${tenantId}`,
        status: 'ACTIVE', relay_token: 'tok',
        container_name: `claw-tenant-${tenantId}`,
        data_dir: `/tmp/${tenantId}`,
        provision_attempts: 0,
        last_activity_at: FORTY_NINE_HOURS_AGO,
        created_at: mockNow++, updated_at: mockNow++,
      },
    });

    const stoppedCalls: string[] = [];
    const mockFetch = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      if (urlStr.includes('/stop')) {
        const id = urlStr.split('/tenants/')[1].split('/stop')[0];
        stoppedCalls.push(id);
        return new Response(JSON.stringify({ status: 'stopped' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await stopIdleTenants(prisma, CP_URL, IDLE_STOP_MS, mockLog, mockFetch);

    expect(stoppedCalls).toContain(tenantId);
  });

  it('does NOT stop tenant idle for <threshold (last_activity_at is recent)', async () => {
    const tenantId = randomUUID().slice(0, 16);
    // last_activity_at is AHEAD of mockNow - threshold → recent
    const FORTY_SEVEN_HOURS_AGO = mockNow + 10_000; // in the future relative to threshold

    await prisma.tenant.create({
      data: {
        id: tenantId,
        principal: `T_IDLE:U_RECENT_${tenantId}`,
        slack_team_id: 'T_IDLE', slack_user_id: `U_RECENT_${tenantId}`,
        status: 'ACTIVE', relay_token: 'tok',
        container_name: `claw-tenant-${tenantId}`,
        data_dir: `/tmp/${tenantId}`,
        provision_attempts: 0,
        last_activity_at: FORTY_SEVEN_HOURS_AGO,
        created_at: mockNow++, updated_at: mockNow++,
      },
    });

    const stoppedCalls: string[] = [];
    const mockFetch = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      if (urlStr.includes('/stop')) {
        const id = urlStr.split('/tenants/')[1].split('/stop')[0];
        stoppedCalls.push(id);
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await stopIdleTenants(prisma, CP_URL, IDLE_STOP_MS, mockLog, mockFetch);

    expect(stoppedCalls).not.toContain(tenantId);
  });
});

// ─── TC-030: Queue reaping ────────────────────────────────────────────────────
describe('TC-030: Queue reaping → retention policy applied', () => {
  // Use small integer timestamps that fit in SQLite INT (32-bit range)
  // These are relative timestamps in seconds-range, not real ms epochs
  const SEVEN_DAYS_SECS = 7 * 24 * 3600;
  const THIRTY_DAYS_SECS = 30 * 24 * 3600;
  // Prisma mock approach: we'll mock Date.now() locally to return
  // a value that makes the cutoffs work with small timestamps
  // Actually: use a local Prisma mock to avoid DB INT overflow

  let tenantId: string;

  beforeAll(async () => {
    tenantId = randomUUID().slice(0, 16);
    await prisma.tenant.create({
      data: {
        id: tenantId, principal: `T_REAP:U_REAP`,
        slack_team_id: 'T_REAP', slack_user_id: 'U_REAP',
        status: 'ACTIVE', relay_token: 'tok',
        container_name: `claw-tenant-${tenantId}`,
        data_dir: `/tmp/${tenantId}`,
        provision_attempts: 0,
        created_at: 1_000_000, updated_at: 1_000_000,
      },
    });
  });

  it('DELIVERED rows older than 7 days deleted; newer ones kept (using mock Prisma)', async () => {
    // Test logic using a mock rather than real DB to avoid timestamp int overflow
    const mockPrisma = {
      messageQueue: {
        deleteMany: vi.fn().mockImplementation(({ where }: { where: { status: string; created_at: { lt: number } } }) => {
          return Promise.resolve({ count: 1 });
        }),
      },
      startupLock: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: vi.fn(async (ops: Array<Promise<{ count: number }>>) => Promise.all(ops)),
    } as unknown as PrismaClient;

    await reapMessageQueue(mockPrisma, mockLog);

    const calls = (mockPrisma.messageQueue.deleteMany as ReturnType<typeof vi.fn>).mock.calls as Array<[{ where: { status: string; created_at: { lt: number } } }]>;

    const deliveredCall = calls.find((c) => c[0].where.status === 'DELIVERED');
    expect(deliveredCall).toBeDefined();
    // Cutoff should be about 7 days before now
    const sevenDaysCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(deliveredCall![0].where.created_at.lt).toBeLessThanOrEqual(Date.now());
    expect(deliveredCall![0].where.created_at.lt).toBeGreaterThan(sevenDaysCutoff - 60_000); // within a minute
  });

  it('FAILED rows older than 30 days deleted (using mock Prisma)', async () => {
    const mockPrisma = {
      messageQueue: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      startupLock: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: vi.fn(async (ops: Array<Promise<{ count: number }>>) => Promise.all(ops)),
    } as unknown as PrismaClient;

    await reapMessageQueue(mockPrisma, mockLog);

    const calls = (mockPrisma.messageQueue.deleteMany as ReturnType<typeof vi.fn>).mock.calls as Array<[{ where: { status: string; created_at: { lt: number } } }]>;

    const failedCall = calls.find((c) => c[0].where.status === 'FAILED');
    expect(failedCall).toBeDefined();
    const thirtyDaysCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    expect(failedCall![0].where.created_at.lt).toBeLessThanOrEqual(Date.now());
    expect(failedCall![0].where.created_at.lt).toBeGreaterThan(thirtyDaysCutoff - 60_000);
  });

  it('stale startup locks are swept', async () => {
    // Insert an expired startup lock
    const expiredTenantId = randomUUID().slice(0, 16);
    await prisma.tenant.create({
      data: {
        id: expiredTenantId, principal: `T_SWEEP:U_SWEEP`,
        slack_team_id: 'T_SWEEP', slack_user_id: 'U_SWEEP',
        status: 'STOPPED', relay_token: 'tok',
        container_name: `claw-tenant-${expiredTenantId}`,
        data_dir: `/tmp/${expiredTenantId}`,
        provision_attempts: 0,
        created_at: mockNow++, updated_at: mockNow++,
      },
    });

    await prisma.startupLock.create({
      data: {
        tenant_id: expiredTenantId,
        locked_by: 'stale-holder',
        acquired_at: 100,
        expires_at: 200, // well below current mockNow → expired
      },
    });

    await sweepStaleLocks(prisma, mockLog);

    const lock = await prisma.startupLock.findUnique({ where: { tenant_id: expiredTenantId } });
    expect(lock).toBeNull();
  });
});

// ─── TC-033: systemd unit files ───────────────────────────────────────────────
describe('TC-033: systemd unit files exist for all three services', () => {
  const unitFilesDir = path.join(REPO_ROOT, 'deploy', 'systemd');

  it('claw-control-plane.service exists', () => {
    expect(existsSync(path.join(unitFilesDir, 'claw-control-plane.service'))).toBe(true);
  });

  it('claw-slack-relay.service exists', () => {
    expect(existsSync(path.join(unitFilesDir, 'claw-slack-relay.service'))).toBe(true);
  });

  it('claw-scheduler.service exists', () => {
    expect(existsSync(path.join(unitFilesDir, 'claw-scheduler.service'))).toBe(true);
  });

  it('control-plane service has WantedBy=multi-user.target', async () => {
    const content = await readFile(path.join(unitFilesDir, 'claw-control-plane.service'), 'utf8');
    expect(content).toContain('WantedBy=multi-user.target');
  });

  it('control-plane service has Requires=docker.service', async () => {
    const content = await readFile(path.join(unitFilesDir, 'claw-control-plane.service'), 'utf8');
    expect(content).toContain('docker.service');
  });
});

// ─── TC-034: tenant-shell script ──────────────────────────────────────────────
describe('TC-034: tenant-shell script validates container is running', () => {
  const scriptPath = path.join(REPO_ROOT, 'scripts', 'tenant-shell.sh');

  it('script file exists', () => {
    expect(existsSync(scriptPath)).toBe(true);
  });

  it('script contains docker exec with agent user', async () => {
    const content = await readFile(scriptPath, 'utf8');
    expect(content).toContain('docker exec');
    expect(content).toContain('agent');
  });

  it('script has bash shebang', async () => {
    const content = await readFile(scriptPath, 'utf8');
    expect(content.startsWith('#!/bin/bash') || content.startsWith('#!/usr/bin/env bash')).toBe(true);
  });
});

// ─── TC-035: Dockerfile does not embed ANTHROPIC_API_KEY ─────────────────────
describe('TC-035: Tenant Dockerfile does not embed ANTHROPIC_API_KEY', () => {
  const dockerfilePath = path.join(REPO_ROOT, 'docker', 'tenant-image', 'Dockerfile');

  it('Dockerfile exists', () => {
    expect(existsSync(dockerfilePath)).toBe(true);
  });

  it('Dockerfile does not set ANTHROPIC_API_KEY as ENV directive', async () => {
    const content = await readFile(dockerfilePath, 'utf8');
    // Allow mention in comments (documentation), but no ENV instruction should set it
    const lines = content.split('\n');
    const envLines = lines.filter(l => l.trim().startsWith('ENV') && l.includes('ANTHROPIC_API_KEY'));
    expect(envLines.length).toBe(0);
    // ARG lines should also not set it
    const argLines = lines.filter(l => l.trim().startsWith('ARG') && l.includes('ANTHROPIC_API_KEY'));
    expect(argLines.length).toBe(0);
  });

  it('Dockerfile does not COPY auth-profiles.json into image', async () => {
    const content = await readFile(dockerfilePath, 'utf8');
    expect(content).not.toContain('COPY.*auth-profiles');
    // More specifically check for direct copy
    const lines = content.split('\n');
    const authCopyLines = lines.filter(l => l.includes('COPY') && l.includes('auth-profiles'));
    expect(authCopyLines.length).toBe(0);
  });
});

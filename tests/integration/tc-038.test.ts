/**
 * TC-038: Health endpoint in tenant container returns correct JSON shape
 *
 * Verifies the health-server.js in docker/tenant-image/:
 *  - File exists
 *  - GET /health handler is present in the code
 *  - Healthy response shape: {ok: true, status: 'healthy', checks: {openclaw, workspace_mounted, home_mounted}, uptime_ms}
 *  - Unhealthy response shape: {ok: false, status: 'starting', checks: {...}}
 *  - Content-Type: application/json is set
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { spawn, ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import http from 'node:http';

const REPO_ROOT = '/home/ubuntu/.openclaw/workspace/claw-orchestrator';
const HEALTH_SERVER_PATH = join(REPO_ROOT, 'docker/tenant-image/health-server.js');
// Use a non-standard port to avoid conflicts with other tests
const TEST_PORT = 13101;

let serverProcess: ChildProcess | null = null;

async function httpGet(url: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () =>
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: data,
        })
      );
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error('Request timed out'));
    });
  });
}

async function waitForServer(port: number, retries = 20, delayMs = 100): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await httpGet(`http://127.0.0.1:${port}/health`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`Server on port ${port} did not start within ${retries * delayMs}ms`);
}

beforeAll(async () => {
  // Spawn the health server on a test port via env override (PORT env var not supported)
  // health-server.js uses hardcoded PORT=3101, so we patch via a wrapper approach:
  // Start it with a modified PORT env that is read... but the file hardcodes 3101.
  // Instead we'll use node -e to create a patched version inline.
  const source = readFileSync(HEALTH_SERVER_PATH, 'utf8');
  // Replace the hardcoded port with our test port
  const patched = source.replace(/const PORT = \d+;/, `const PORT = ${TEST_PORT};`);

  serverProcess = spawn(process.execPath, ['-e', patched], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stderr?.on('data', () => {}); // suppress stderr
  serverProcess.stdout?.on('data', () => {}); // suppress stdout

  await waitForServer(TEST_PORT);
}, 15_000);

afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}, 10_000);

describe('TC-038: Health endpoint in tenant container returns correct JSON shape', () => {
  it('TC-038: health-server.js file exists at docker/tenant-image/health-server.js', () => {
    expect(existsSync(HEALTH_SERVER_PATH), 'health-server.js should exist').toBe(true);
  });

  it('TC-038: source code contains GET /health handler', () => {
    const source = readFileSync(HEALTH_SERVER_PATH, 'utf8');
    expect(source).toContain("req.url !== '/health'");
    expect(source).toContain("req.method !== 'GET'");
    expect(source).toContain('http.createServer');
  });

  it('TC-038: GET /health sets Content-Type: application/json', async () => {
    const { headers } = await httpGet(`http://127.0.0.1:${TEST_PORT}/health`);
    expect(headers['content-type']).toContain('application/json');
  });

  it('TC-038: unhealthy response has correct shape {ok: false, status: "starting", checks: {...}}', async () => {
    // In test env: openclaw not running, /workspace and /home/agent don't exist → 503
    const { statusCode, body, headers } = await httpGet(`http://127.0.0.1:${TEST_PORT}/health`);

    expect(headers['content-type']).toContain('application/json');

    const json = JSON.parse(body);

    // When any check fails, we get the unhealthy shape
    if (!json.ok) {
      expect(json.ok).toBe(false);
      expect(json.status).toBe('starting');
      expect(json.checks).toBeDefined();
      expect(typeof json.checks.openclaw).toBe('boolean');
      expect(typeof json.checks.workspace_mounted).toBe('boolean');
      expect(typeof json.checks.home_mounted).toBe('boolean');
      // uptime_ms must NOT be present in unhealthy response
      expect(json.uptime_ms).toBeUndefined();
      expect(statusCode).toBe(503);
    } else {
      // Healthy response — validate that shape instead
      expect(json.ok).toBe(true);
      expect(json.status).toBe('healthy');
      expect(json.checks).toBeDefined();
      expect(typeof json.checks.openclaw).toBe('boolean');
      expect(typeof json.checks.workspace_mounted).toBe('boolean');
      expect(typeof json.checks.home_mounted).toBe('boolean');
      expect(typeof json.uptime_ms).toBe('number');
      expect(statusCode).toBe(200);
    }
  });

  it('TC-038: source code defines healthy response shape {ok: true, status: "healthy", checks, uptime_ms}', () => {
    const source = readFileSync(HEALTH_SERVER_PATH, 'utf8');
    // Verify the healthy response JSON shape is defined in source
    expect(source).toContain("ok: true");
    expect(source).toContain("status: 'healthy'");
    expect(source).toContain('uptime_ms:');
    expect(source).toContain('checks,');
  });

  it('TC-038: source code defines unhealthy response shape {ok: false, status: "starting", checks}', () => {
    const source = readFileSync(HEALTH_SERVER_PATH, 'utf8');
    expect(source).toContain("ok: false");
    expect(source).toContain("status: 'starting'");
  });

  it('TC-038: source code defines all three required check fields', () => {
    const source = readFileSync(HEALTH_SERVER_PATH, 'utf8');
    expect(source).toContain('openclaw:');
    expect(source).toContain('workspace_mounted:');
    expect(source).toContain('home_mounted:');
  });

  it('TC-038: GET /health returns JSON parseable response with required shape fields', async () => {
    const { body } = await httpGet(`http://127.0.0.1:${TEST_PORT}/health`);
    const json = JSON.parse(body);

    // Regardless of healthy/unhealthy, these fields must always be present
    expect(typeof json.ok).toBe('boolean');
    expect(typeof json.status).toBe('string');
    expect(json.checks).toBeDefined();
    expect(typeof json.checks).toBe('object');
    expect(typeof json.checks.openclaw).toBe('boolean');
    expect(typeof json.checks.workspace_mounted).toBe('boolean');
    expect(typeof json.checks.home_mounted).toBe('boolean');

    // If healthy, uptime_ms must be present
    if (json.ok) {
      expect(typeof json.uptime_ms).toBe('number');
    }
  });
});

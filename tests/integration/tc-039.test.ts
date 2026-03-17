/**
 * TC-039: Message endpoint in tenant container validates relay token
 *
 * Verifies the message-server.js in docker/tenant-image/:
 *  - File exists
 *  - Validates X-Relay-Token against RELAY_TOKEN env var
 *  - Returns 401 on token mismatch
 *  - Success response shape: {ok: true, response: '...', blocks: null}
 *  - Error response shape: {ok: false, error: '...'}
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { spawn, ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import http from 'node:http';
import os from 'node:os';

const REPO_ROOT = '/home/ubuntu/.openclaw/workspace/claw-orchestrator';
const MESSAGE_SERVER_PATH = join(REPO_ROOT, 'docker/tenant-image/message-server.js');
const TEST_PORT = 13100;
const TEST_RELAY_TOKEN = 'test-relay-token-tc039';

let serverProcess: ChildProcess | null = null;
let tmpDir: string | null = null;

interface HttpResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function httpPost(url: string, body: unknown, headers: Record<string, string> = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: parseInt(urlObj.port),
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...headers,
      },
    };
    const req = http.request(options, (res) => {
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
    req.write(bodyStr);
    req.end();
  });
}

async function waitForServer(port: number, retries = 30, delayMs = 100): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      // Send a request with no token to see if server is up (401 means it's up)
      await httpPost(`http://127.0.0.1:${port}/message`, {});
      return;
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`Server on port ${port} did not start within ${retries * delayMs}ms`);
}

beforeAll(async () => {
  // Create a temp dir with a mock `openclaw` binary that echoes a fixed response
  tmpDir = join(os.tmpdir(), `tc039-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  const mockOpenclaw = join(tmpDir, 'openclaw');
  writeFileSync(mockOpenclaw, '#!/bin/sh\necho "Hello from mock openclaw"\n');
  chmodSync(mockOpenclaw, 0o755);

  const source = readFileSync(MESSAGE_SERVER_PATH, 'utf8');
  // Replace the hardcoded port with our test port
  const patched = source.replace(/const PORT = \d+;/, `const PORT = ${TEST_PORT};`);

  serverProcess = spawn(process.execPath, ['-e', patched], {
    env: {
      ...process.env,
      RELAY_TOKEN: TEST_RELAY_TOKEN,
      PATH: `${tmpDir}:${process.env.PATH}`,
    },
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
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
}, 10_000);

const validMessageBody = {
  messageId: 'msg-001',
  slackEventId: 'evt-001',
  userId: 'U123',
  teamId: 'T123',
  text: 'hello',
  slackPayload: {},
  timestamp: Date.now(),
};

describe('TC-039: Message endpoint in tenant container validates relay token', () => {
  it('TC-039: message-server.js file exists at docker/tenant-image/message-server.js', () => {
    expect(existsSync(MESSAGE_SERVER_PATH), 'message-server.js should exist').toBe(true);
  });

  it('TC-039: source code validates X-Relay-Token against RELAY_TOKEN env var', () => {
    const source = readFileSync(MESSAGE_SERVER_PATH, 'utf8');
    expect(source).toContain('RELAY_TOKEN');
    expect(source).toContain("'x-relay-token'");
    expect(source).toContain('401');
    expect(source).toContain('Unauthorized');
  });

  it('TC-039: returns 401 when X-Relay-Token header is missing', async () => {
    const { statusCode, body } = await httpPost(
      `http://127.0.0.1:${TEST_PORT}/message`,
      validMessageBody,
      {} // no X-Relay-Token
    );
    expect(statusCode).toBe(401);
    const json = JSON.parse(body);
    expect(json.ok).toBe(false);
    expect(typeof json.error).toBe('string');
  });

  it('TC-039: returns 401 when X-Relay-Token is wrong', async () => {
    const { statusCode, body } = await httpPost(
      `http://127.0.0.1:${TEST_PORT}/message`,
      validMessageBody,
      { 'X-Relay-Token': 'wrong-token' }
    );
    expect(statusCode).toBe(401);
    const json = JSON.parse(body);
    expect(json.ok).toBe(false);
    expect(typeof json.error).toBe('string');
  });

  it('TC-039: 401 response matches error shape {ok: false, error: string}', async () => {
    const { body } = await httpPost(
      `http://127.0.0.1:${TEST_PORT}/message`,
      validMessageBody,
      { 'X-Relay-Token': 'bad-token' }
    );
    const json = JSON.parse(body);
    expect(json).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it('TC-039: returns 400 error shape {ok: false, error: string} when body is invalid JSON', async () => {
    // Send raw invalid JSON with correct token
    const response = await new Promise<HttpResponse>((resolve, reject) => {
      const rawBody = 'not-json';
      const options = {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/message',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(rawBody),
          'X-Relay-Token': TEST_RELAY_TOKEN,
        },
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: data })
        );
      });
      req.on('error', reject);
      req.write(rawBody);
      req.end();
    });
    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.body);
    expect(json.ok).toBe(false);
    expect(typeof json.error).toBe('string');
  });

  it('TC-039: success response shape is {ok: true, response: string, blocks: null}', async () => {
    const { statusCode, body } = await httpPost(
      `http://127.0.0.1:${TEST_PORT}/message`,
      validMessageBody,
      { 'X-Relay-Token': TEST_RELAY_TOKEN }
    );
    expect(statusCode).toBe(200);
    const json = JSON.parse(body);
    expect(json.ok).toBe(true);
    expect(typeof json.response).toBe('string');
    expect(json.blocks).toBeNull();
  });

  it('TC-039: source code defines success response shape {ok: true, response, blocks}', () => {
    const source = readFileSync(MESSAGE_SERVER_PATH, 'utf8');
    expect(source).toContain('ok: true');
    expect(source).toContain('response: result.response');
    expect(source).toContain('blocks: result.blocks');
  });

  it('TC-039: source code defines error response shape {ok: false, error}', () => {
    const source = readFileSync(MESSAGE_SERVER_PATH, 'utf8');
    expect(source).toContain('ok: false');
    expect(source).toContain("error: err.message");
  });
});

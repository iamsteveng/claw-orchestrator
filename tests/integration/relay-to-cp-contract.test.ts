/**
 * US-003: Contract test — relay → control plane message endpoint
 *
 * Verifies that when the relay processes a Slack event, it calls
 * POST /v1/tenants/:tenantId/message on the control plane with:
 *   - correct path
 *   - correct HTTP method (POST)
 *   - x-relay-token header present
 *
 * Uses a real buildSlackRelayApp instance + a real in-process Fastify
 * mock server on a random port to act as the control plane.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac } from 'node:crypto';
import { buildSlackRelayApp } from '../../apps/slack-relay/src/app-factory.js';
import type { SlackRelayConfig } from '@claw/shared-config/slack-relay';

// ─── Mock CP server helpers ──────────────────────────────────────────────────

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

function startMockCpServer(
  port: number,
  responsesByPath: Record<string, { status: number; body: object }>,
): Promise<{ requests: CapturedRequest[]; close: () => Promise<void> }> {
  const requests: CapturedRequest[] = [];

  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let body: unknown = {};
        try { body = JSON.parse(rawBody); } catch { /* ignore */ }

        requests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers as Record<string, string | string[] | undefined>,
          body,
        });

        const match = responsesByPath[req.url ?? ''] ?? { status: 200, body: { ok: true } };
        res.writeHead(match.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(match.body));
      });
    });

    server.listen(port, '127.0.0.1', () => resolve({
      requests,
      close: () => new Promise<void>((res) => server.close(() => res())),
    }));
    server.on('error', reject);
  });
}

// ─── Slack signature helpers ─────────────────────────────────────────────────

const SIGNING_SECRET = 'test-signing-secret-us003';

function makeSlackHeaders(rawBody: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const baseString = `v0:${timestamp}:${rawBody}`;
  const sig = `v0=${createHmac('sha256', SIGNING_SECRET).update(baseString).digest('hex')}`;
  return {
    'x-slack-signature': sig,
    'x-slack-request-timestamp': timestamp,
    'content-type': 'application/json',
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TENANT_ID = 'tenantus003aa';   // 13 hex-like chars (simulate sha256 slice)
const RELAY_TOKEN = 'relay-tok-us003';
const CP_PORT = 19003;

// ─── Setup / teardown ────────────────────────────────────────────────────────

let mockCp: Awaited<ReturnType<typeof startMockCpServer>>;

beforeAll(async () => {
  mockCp = await startMockCpServer(CP_PORT, {
    '/v1/tenants/provision': { status: 200, body: { tenantId: TENANT_ID, status: 'ACTIVE', relayToken: RELAY_TOKEN } },
    [`/v1/tenants/${TENANT_ID}/message`]: { status: 200, body: { ok: true, response: 'Hi there!' } },
  });
});

afterAll(async () => {
  await mockCp.close();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('US-003: relay → CP message endpoint contract', () => {
  it('sends POST /v1/tenants/:tenantId/message with x-relay-token when CP returns 200', async () => {
    const config: SlackRelayConfig = {
      SLACK_RELAY_PORT: 0,
      SLACK_SIGNING_SECRET: SIGNING_SECRET,
      SLACK_BOT_TOKEN: 'xoxb-us003',
      CONTROL_PLANE_URL: `http://127.0.0.1:${CP_PORT}`,
    };

    // Mock Slack API calls (conversations.open + chat.postMessage)
    const slackFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = String(url);
      // Forward CP calls to the mock server
      if (urlStr.startsWith(`http://127.0.0.1:${CP_PORT}`)) {
        return fetch(url, init);
      }
      // Slack API stubs
      if (urlStr.includes('conversations.open')) {
        return new Response(JSON.stringify({ ok: true, channel: { id: 'D_US003' } }), { status: 200 });
      }
      if (urlStr.includes('chat.postMessage')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const relay = await buildSlackRelayApp(config, slackFetch);

    const envelope = {
      type: 'event_callback',
      team_id: 'T_US003',
      event_id: 'Ev_US003_001',
      event: { user: 'U_US003', type: 'message', text: 'hello from contract test' },
    };
    const rawBody = JSON.stringify(envelope);

    // Send event and wait for 200 (fire-and-forget)
    const res = await relay.inject({
      method: 'POST',
      url: '/slack/events',
      headers: makeSlackHeaders(rawBody),
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);

    // Wait for async processing to complete
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    // Verify mock CP received the message call
    const msgRequests = mockCp.requests.filter((r) =>
      r.url === `/v1/tenants/${TENANT_ID}/message`,
    );

    expect(msgRequests.length).toBeGreaterThanOrEqual(1);
    const msgReq = msgRequests[0]!;
    expect(msgReq.method).toBe('POST');
    expect(msgReq.headers['x-relay-token']).toBe(RELAY_TOKEN);
    expect(msgReq.body).toMatchObject({
      userId: 'U_US003',
      teamId: 'T_US003',
      text: 'hello from contract test',
    });

    await relay.close();
  });

  it('does not crash when CP message endpoint returns 500', async () => {
    // Use a separate mock CP that returns 500 for the message endpoint
    const cpPort500 = 19004;
    const mockCp500 = await startMockCpServer(cpPort500, {
      '/v1/tenants/provision': { status: 200, body: { tenantId: TENANT_ID, status: 'ACTIVE', relayToken: RELAY_TOKEN } },
      [`/v1/tenants/${TENANT_ID}/message`]: { status: 500, body: { error: 'internal error' } },
    });

    const config: SlackRelayConfig = {
      SLACK_RELAY_PORT: 0,
      SLACK_SIGNING_SECRET: SIGNING_SECRET,
      SLACK_BOT_TOKEN: 'xoxb-us003',
      CONTROL_PLANE_URL: `http://127.0.0.1:${cpPort500}`,
    };

    const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

    const slackFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.startsWith(`http://127.0.0.1:${cpPort500}`)) {
        return fetch(url, init);
      }
      if (urlStr.includes('conversations.open')) {
        return new Response(JSON.stringify({ ok: true, channel: { id: 'D_US003B' } }), { status: 200 });
      }
      if (urlStr.includes('chat.postMessage')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const relay = await buildSlackRelayApp(config, slackFetch);

    const envelope = {
      type: 'event_callback',
      team_id: 'T_US003',
      event_id: 'Ev_US003_500',
      event: { user: 'U_US003', type: 'message', text: 'trigger 500 path' },
    };
    const rawBody = JSON.stringify(envelope);

    // Should return 200 to Slack immediately (fire-and-forget)
    const res = await relay.inject({
      method: 'POST',
      url: '/slack/events',
      headers: makeSlackHeaders(rawBody),
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);

    // Wait for async processing
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    // Verify the mock CP received the message request
    const msgRequests = mockCp500.requests.filter((r) =>
      r.url === `/v1/tenants/${TENANT_ID}/message`,
    );
    expect(msgRequests.length).toBeGreaterThanOrEqual(1);

    await relay.close();
    await mockCp500.close();
  });
});

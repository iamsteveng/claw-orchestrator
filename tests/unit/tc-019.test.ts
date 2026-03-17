/**
 * TC-019: Slack signature verification → valid/invalid/expired
 *
 * Verifies that POST /slack/events enforces Slack's HMAC-SHA256 signature scheme,
 * including replay protection (timestamp age) and url_verification challenge.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { buildSlackRelayApp } from '../../apps/slack-relay/src/app-factory.js';
import type { SlackRelayConfig } from '@claw/shared-config/slack-relay';

const SIGNING_SECRET = 'test-signing-secret-tc019';

const TEST_CONFIG: SlackRelayConfig = {
  SLACK_RELAY_PORT: 3000,
  SLACK_SIGNING_SECRET: SIGNING_SECRET,
  SLACK_BOT_TOKEN: 'xoxb-test-token',
  CONTROL_PLANE_URL: 'http://localhost:9999',
};

/** Computes a valid Slack HMAC signature for the given body and timestamp. */
function makeSignature(body: string, timestamp: string, secret = SIGNING_SECRET): string {
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = createHmac('sha256', secret);
  hmac.update(baseString);
  return `v0=${hmac.digest('hex')}`;
}

/** Returns current Unix timestamp as a string. */
function nowTs(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe('TC-019: Slack signature verification → valid/invalid/expired', () => {
  it('TC-019: valid HMAC signature → HTTP 200', async () => {
    // Mock fetch so the fire-and-forget processSlackEventWithConfig doesn't
    // attempt real network calls.
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);

    const app = await buildSlackRelayApp(TEST_CONFIG, mockFetch as typeof fetch);

    const body = JSON.stringify({ type: 'event_callback', team_id: 'T123', event: { user: 'U456', type: 'message', text: 'hello' } });
    const ts = nowTs();
    const sig = makeSignature(body, ts);

    const res = await app.inject({
      method: 'POST',
      url: '/slack/events',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': sig,
        'x-slack-request-timestamp': ts,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('TC-019: invalid signature → HTTP 403', async () => {
    const app = await buildSlackRelayApp(TEST_CONFIG, vi.fn() as unknown as typeof fetch);

    const body = JSON.stringify({ type: 'event_callback' });
    const ts = nowTs();

    const res = await app.inject({
      method: 'POST',
      url: '/slack/events',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': 'v0=invaliddeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        'x-slack-request-timestamp': ts,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it('TC-019: timestamp 6 minutes old → HTTP 403 (replay protection)', async () => {
    const app = await buildSlackRelayApp(TEST_CONFIG, vi.fn() as unknown as typeof fetch);

    const body = JSON.stringify({ type: 'event_callback' });
    const staleTs = String(Math.floor(Date.now() / 1000) - 6 * 60); // 6 minutes ago
    const sig = makeSignature(body, staleTs);

    const res = await app.inject({
      method: 'POST',
      url: '/slack/events',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': sig,
        'x-slack-request-timestamp': staleTs,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it('TC-019: missing X-Slack-Signature → HTTP 403', async () => {
    const app = await buildSlackRelayApp(TEST_CONFIG, vi.fn() as unknown as typeof fetch);

    const body = JSON.stringify({ type: 'event_callback' });
    const ts = nowTs();

    const res = await app.inject({
      method: 'POST',
      url: '/slack/events',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        // no x-slack-signature
      },
      payload: body,
    });

    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it('TC-019: url_verification type → returns {challenge} synchronously', async () => {
    const app = await buildSlackRelayApp(TEST_CONFIG, vi.fn() as unknown as typeof fetch);

    const challenge = 'my-unique-challenge-string';
    const body = JSON.stringify({ type: 'url_verification', challenge });
    const ts = nowTs();
    const sig = makeSignature(body, ts);

    const res = await app.inject({
      method: 'POST',
      url: '/slack/events',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': sig,
        'x-slack-request-timestamp': ts,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body) as { challenge?: string };
    expect(json.challenge).toBe(challenge);

    await app.close();
  });
});

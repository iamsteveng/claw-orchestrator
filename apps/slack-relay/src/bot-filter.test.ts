/**
 * Tests for bot self-message filtering (US-002).
 *
 * Verifies:
 * 1. Event where envelope.event.user === botUserId is NOT processed
 * 2. Event where envelope.event.user !== botUserId IS processed normally
 * 3. Event with bot_id field is still filtered (existing check preserved)
 * 4. Event with subtype 'bot_message' is still filtered (existing check preserved)
 * 5. If auth.test fails at startup, bot still functions (graceful degradation)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { buildSlackRelayApp } from './app-factory.js';
import type { FastifyInstance } from 'fastify';
import type { SlackRelayConfig } from '@claw/shared-config/slack-relay';

// ─── Helpers ────────────────────────────────────────────────────────────────

const SIGNING_SECRET = 'bot-filter-test-secret';
const BOT_USER_ID = 'U_BOT_SELF';
const HUMAN_USER_ID = 'U_HUMAN';

const TEST_CONFIG: SlackRelayConfig = {
  SLACK_RELAY_PORT: 19910,
  SLACK_SIGNING_SECRET: SIGNING_SECRET,
  SLACK_BOT_TOKEN: 'xoxb-bot-filter-test',
  CONTROL_PLANE_URL: 'http://127.0.0.1:19911',
};

function makeSlackHeaders(body: string, secret = SIGNING_SECRET) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = createHmac('sha256', secret);
  hmac.update(baseString);
  const signature = `v0=${hmac.digest('hex')}`;
  return {
    'x-slack-signature': signature,
    'x-slack-request-timestamp': timestamp,
    'content-type': 'application/json',
  };
}

function makeEventBody(userId: string, eventId: string, extras: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'event_callback',
    team_id: 'T_BOT_FILTER',
    event_id: eventId,
    event_time: Math.floor(Date.now() / 1000),
    event: { user: userId, type: 'message', text: 'hello', channel: 'C001', ...extras },
  });
}

/**
 * Build a fetch mock that:
 * - Responds to auth.test with a known botUserId
 * - Responds to everything else with 200 {}
 */
function makeAuthMockFetch(resolvedBotUserId: string) {
  return vi.fn().mockImplementation((url: string) => {
    if (String(url).includes('auth.test')) {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, user_id: resolvedBotUserId }), { status: 200 }),
      );
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
}

/**
 * Build a fetch mock where auth.test fails (network error).
 */
function makeAuthFailFetch() {
  return vi.fn().mockImplementation((url: string) => {
    if (String(url).includes('auth.test')) {
      return Promise.reject(new Error('Network error'));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('bot self-message filtering', () => {
  let app: FastifyInstance;
  let fetchFn: ReturnType<typeof vi.fn>;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('does NOT process events from the bot user ID (no provision call made)', async () => {
    fetchFn = makeAuthMockFetch(BOT_USER_ID);
    app = await buildSlackRelayApp(TEST_CONFIG, fetchFn as unknown as typeof fetch);
    await app.ready();

    const body = makeEventBody(BOT_USER_ID, 'Ev-bot-self-001');
    const res = await app.inject({
      method: 'POST',
      url: '/slack/events',
      headers: makeSlackHeaders(body),
      payload: body,
    });
    expect(res.statusCode).toBe(200);

    // Allow fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 20));

    const provisionCalls = fetchFn.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('/provision'),
    );
    expect(provisionCalls).toHaveLength(0);
  });

  it('processes events from a different user normally (provision call made)', async () => {
    fetchFn = makeAuthMockFetch(BOT_USER_ID);
    app = await buildSlackRelayApp(TEST_CONFIG, fetchFn as unknown as typeof fetch);
    await app.ready();

    const body = makeEventBody(HUMAN_USER_ID, 'Ev-human-001');
    const res = await app.inject({
      method: 'POST',
      url: '/slack/events',
      headers: makeSlackHeaders(body),
      payload: body,
    });
    expect(res.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 20));

    const provisionCalls = fetchFn.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('/provision'),
    );
    expect(provisionCalls).toHaveLength(1);
  });

  it('still filters events with bot_id field (existing check preserved)', async () => {
    fetchFn = makeAuthMockFetch(BOT_USER_ID);
    app = await buildSlackRelayApp(TEST_CONFIG, fetchFn as unknown as typeof fetch);
    await app.ready();

    // Use a different user (not bot self) but with bot_id in the event
    const body = makeEventBody(HUMAN_USER_ID, 'Ev-botid-001', { bot_id: 'B_SOME_BOT' });
    const res = await app.inject({
      method: 'POST',
      url: '/slack/events',
      headers: makeSlackHeaders(body),
      payload: body,
    });
    expect(res.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 20));

    const provisionCalls = fetchFn.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('/provision'),
    );
    expect(provisionCalls).toHaveLength(0);
  });

  it('still filters events with subtype bot_message (existing check preserved)', async () => {
    fetchFn = makeAuthMockFetch(BOT_USER_ID);
    app = await buildSlackRelayApp(TEST_CONFIG, fetchFn as unknown as typeof fetch);
    await app.ready();

    const body = makeEventBody(HUMAN_USER_ID, 'Ev-subtype-001', { subtype: 'bot_message' });
    const res = await app.inject({
      method: 'POST',
      url: '/slack/events',
      headers: makeSlackHeaders(body),
      payload: body,
    });
    expect(res.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 20));

    const provisionCalls = fetchFn.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('/provision'),
    );
    expect(provisionCalls).toHaveLength(0);
  });

  it('still processes events normally when auth.test fails at startup (graceful degradation)', async () => {
    fetchFn = makeAuthFailFetch();
    // Should not throw even if auth.test fails
    app = await buildSlackRelayApp(TEST_CONFIG, fetchFn as unknown as typeof fetch);
    await app.ready();

    // Reset mock so subsequent calls don't reject (provision needs to succeed)
    fetchFn.mockReset();
    fetchFn.mockResolvedValue(new Response('{}', { status: 200 }));

    const body = makeEventBody(HUMAN_USER_ID, 'Ev-authfail-001');
    const res = await app.inject({
      method: 'POST',
      url: '/slack/events',
      headers: makeSlackHeaders(body),
      payload: body,
    });
    expect(res.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 20));

    const provisionCalls = fetchFn.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('/provision'),
    );
    // With no botUserId resolved, events from any user are processed normally
    expect(provisionCalls).toHaveLength(1);
  });
});

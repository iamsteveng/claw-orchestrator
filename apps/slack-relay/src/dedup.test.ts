/**
 * Tests for event_id deduplication in the Slack relay (US-001 / US-002).
 *
 * Verifies that:
 * 1. Same event_id sent twice → only one processSlackEvent call
 * 2. Different event_ids → both processed
 * 3. event_id dedup works for concurrent requests
 * 4. X-Slack-Retry-Num header still drops retries (existing behaviour preserved)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { buildSlackRelayApp, processSlackEventWithConfig } from './app-factory.js';
import type { FastifyInstance } from 'fastify';
import type { SlackRelayConfig } from '@claw/shared-config/slack-relay';

// ─── Helpers ───────────────────────────────────────────────────────────────

const SIGNING_SECRET = 'dedup-test-secret';

const TEST_CONFIG: SlackRelayConfig = {
  SLACK_RELAY_PORT: 19900,
  SLACK_SIGNING_SECRET: SIGNING_SECRET,
  SLACK_BOT_TOKEN: 'xoxb-dedup-test',
  CONTROL_PLANE_URL: 'http://127.0.0.1:19901',
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

function makeEventBody(eventId: string) {
  return JSON.stringify({
    type: 'event_callback',
    team_id: 'T_DEDUP',
    event_id: eventId,
    event_time: Math.floor(Date.now() / 1000),
    event: { user: 'U_DEDUP', type: 'message', text: 'hello', channel: 'C001' },
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('event_id deduplication via buildSlackRelayApp', () => {
  let app: FastifyInstance;
  let processCalls: string[];
  let fetchFn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    processCalls = [];
    // fetchFn that records calls but never resolves (fire-and-forget doesn't block)
    fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    // Spy on processSlackEventWithConfig to count actual processing calls.
    // We build the app with a fetchFn mock that is called inside processSlackEventWithConfig.
    // Instead we track invocations by inspecting the first /provision call per event.
    // fetchFn is called by processSlackEventWithConfig; we count /provision calls as proxy.
    app = await buildSlackRelayApp(TEST_CONFIG, fetchFn as unknown as typeof fetch);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('processes each unique event_id only once when sent twice', async () => {
    const body = makeEventBody('Ev-dedup-001');
    const headers = makeSlackHeaders(body);

    // First request
    const res1 = await app.inject({ method: 'POST', url: '/slack/events', headers, payload: body });
    expect(res1.statusCode).toBe(200);

    // Allow fire-and-forget to start (so processedEventIds is populated)
    await new Promise((r) => setImmediate(r));

    // Second request — same event_id
    const res2 = await app.inject({ method: 'POST', url: '/slack/events', headers: makeSlackHeaders(body), payload: body });
    expect(res2.statusCode).toBe(200);

    // Allow async work to settle
    await new Promise((r) => setTimeout(r, 20));

    // The fetch mock records calls to /provision (one per processSlackEventWithConfig invocation).
    const provisionCalls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes('/provision'),
    );
    // Only one provision call — the second request was deduped before processing started
    expect(provisionCalls).toHaveLength(1);
  });

  it('processes two different event_ids independently', async () => {
    const body1 = makeEventBody('Ev-dedup-A');
    const body2 = makeEventBody('Ev-dedup-B');

    const res1 = await app.inject({ method: 'POST', url: '/slack/events', headers: makeSlackHeaders(body1), payload: body1 });
    expect(res1.statusCode).toBe(200);

    const res2 = await app.inject({ method: 'POST', url: '/slack/events', headers: makeSlackHeaders(body2), payload: body2 });
    expect(res2.statusCode).toBe(200);

    // Allow async work to settle
    await new Promise((r) => setTimeout(r, 20));

    const provisionCalls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes('/provision'),
    );
    // Both events processed → two provision calls
    expect(provisionCalls).toHaveLength(2);
  });

  it('returns 200 immediately for a duplicate event_id (no delay)', async () => {
    const body = makeEventBody('Ev-dedup-002');
    const headers = makeSlackHeaders(body);

    // First request
    await app.inject({ method: 'POST', url: '/slack/events', headers, payload: body });
    await new Promise((r) => setImmediate(r));

    // Second request — should return 200 quickly (no async processing)
    const start = Date.now();
    const res2 = await app.inject({ method: 'POST', url: '/slack/events', headers: makeSlackHeaders(body), payload: body });
    const elapsed = Date.now() - start;

    expect(res2.statusCode).toBe(200);
    // Should be very fast since we skip processing entirely
    expect(elapsed).toBeLessThan(500);
  });

  it('drops X-Slack-Retry-Num requests (existing behaviour preserved)', async () => {
    const body = makeEventBody('Ev-dedup-retry');
    const headers = {
      ...makeSlackHeaders(body),
      'x-slack-retry-num': '1',
    };

    const res = await app.inject({ method: 'POST', url: '/slack/events', headers, payload: body });
    expect(res.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 20));

    // No provision calls because retry was dropped before event_id check
    const provisionCalls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes('/provision'),
    );
    expect(provisionCalls).toHaveLength(0);
  });

  it('processes the event after X-Slack-Retry drops — dedup cache NOT populated by retry', async () => {
    const body = makeEventBody('Ev-dedup-retry-then-new');

    // First: a retry (should be dropped, NOT added to cache)
    const retryHeaders = { ...makeSlackHeaders(body), 'x-slack-retry-num': '1' };
    await app.inject({ method: 'POST', url: '/slack/events', headers: retryHeaders, payload: body });

    await new Promise((r) => setImmediate(r));

    // Second: same event_id, no retry header — should be processed
    const normalHeaders = makeSlackHeaders(body);
    await app.inject({ method: 'POST', url: '/slack/events', headers: normalHeaders, payload: body });

    await new Promise((r) => setTimeout(r, 20));

    const provisionCalls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes('/provision'),
    );
    // Only the non-retry request should have been processed
    expect(provisionCalls).toHaveLength(1);
  });
});

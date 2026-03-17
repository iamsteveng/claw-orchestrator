/**
 * TC-020: Interim message sent at 15s when agent takes too long
 *
 * Verifies that when the tenant runtime takes longer than 15 seconds to respond,
 * the relay posts '⏳ Working on it...' to Slack exactly once. After the mock
 * response arrives at 20s, the final agent response is also posted.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { processSlackEvent, type SlackEventEnvelope } from '../../apps/slack-relay/src/index.js';

const makeLog = () => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
});

const ENVELOPE: SlackEventEnvelope = {
  type: 'event_callback',
  team_id: 'T020',
  event_id: 'Ev020',
  event: { user: 'U020', text: 'please do something slow', type: 'message' },
};

const FINAL_RESPONSE = 'Here is your answer after 20 seconds';

/**
 * Build a fetchFn where:
 * - /provision → ACTIVE immediately
 * - conversations.open → success
 * - chat.postMessage → captured in `dmTexts`
 * - /message → resolves after 20s with a real agent response (uses setTimeout so fake timers control it)
 */
function makeSlowFetchFn(dmTexts: string[], delayMs: number) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (String(url).includes('/provision')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ tenantId: 'tc020tenantid1234', status: 'ACTIVE', relayToken: 'relay-tok-020' }),
          { status: 200 },
        ),
      );
    }

    if (String(url).includes('/start')) {
      return Promise.resolve(new Response('{}', { status: 200 }));
    }

    if (String(url).includes('conversations.open')) {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, channel: { id: 'D020' } }), { status: 200 }),
      );
    }

    if (String(url).includes('chat.postMessage')) {
      const body = JSON.parse((init?.body as string) ?? '{}') as { text?: string };
      if (body.text) dmTexts.push(body.text);
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }

    if (String(url).includes('/message')) {
      // Resolves after `delayMs` via setTimeout — controlled by vi.useFakeTimers()
      return new Promise<Response>((resolve) => {
        setTimeout(() => {
          resolve(
            new Response(
              JSON.stringify({ ok: true, response: FINAL_RESPONSE }),
              { status: 200 },
            ),
          );
        }, delayMs);
      });
    }

    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('TC-020: Interim message sent at 15s when agent takes too long', () => {
  it('TC-020: sends "⏳ Working on it..." after 15s when tenant delays 20s', async () => {
    vi.useFakeTimers();

    const dmTexts: string[] = [];
    const fetchFn = makeSlowFetchFn(dmTexts, 20_000);

    const processPromise = processSlackEvent(ENVELOPE, makeLog() as never, fetchFn);

    // Advance to just past 15s — interim message should fire
    await vi.advanceTimersByTimeAsync(15_001);
    // Flush microtasks from the interim DM calls (conversations.open + chat.postMessage)
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(dmTexts).toContain('⏳ Working on it...');
  });

  it('TC-020: interim message sent only once (not repeated)', async () => {
    vi.useFakeTimers();

    const dmTexts: string[] = [];
    const fetchFn = makeSlowFetchFn(dmTexts, 20_000);

    const processPromise = processSlackEvent(ENVELOPE, makeLog() as never, fetchFn);

    // Advance well past 15s to confirm no duplicate firing
    await vi.advanceTimersByTimeAsync(19_999);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const interimCount = dmTexts.filter((t) => t.includes('⏳ Working on it')).length;
    expect(interimCount).toBe(1);

    // Let the response arrive and finish
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();
    await Promise.resolve();
    await processPromise;
  });

  it('TC-020: final agent response posted to Slack after 20s delay', async () => {
    vi.useFakeTimers();

    const dmTexts: string[] = [];
    const fetchFn = makeSlowFetchFn(dmTexts, 20_000);

    const processPromise = processSlackEvent(ENVELOPE, makeLog() as never, fetchFn);

    // Advance past the 20s delay so the mock message endpoint resolves
    await vi.advanceTimersByTimeAsync(20_001);
    // Flush all the async chains: fetch resolve → json() → chat.postMessage → response
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await processPromise;

    expect(dmTexts).toContain(FINAL_RESPONSE);
  });
});

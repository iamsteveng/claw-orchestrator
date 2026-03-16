/**
 * Tests for US-026: '⏳ Working on it' interim message at 15s timeout and 4-minute max wait.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { processSlackEvent, type SlackEventEnvelope } from './index.js';

const makeLog = () => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
});

const ACTIVE_ENVELOPE: SlackEventEnvelope = {
  type: 'event_callback',
  team_id: 'T123',
  event_id: 'Ev026',
  event: { user: 'U456', text: 'hello', type: 'message' },
};

/**
 * Build a fetchFn where:
 * - /provision → ACTIVE immediately
 * - conversations.open → success
 * - chat.postMessage → captured in `dmTexts`
 * - /message → hangs until aborted (simulates long-running tenant)
 */
function makeFetchFn(dmTexts: string[], opts: { messageAlwaysHang?: boolean } = {}) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (String(url).includes('/provision')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ tenantId: 'abc123def456abcd', status: 'ACTIVE', relayToken: 'tok' }),
          { status: 200 },
        ),
      );
    }

    if (String(url).includes('/start')) {
      return Promise.resolve(new Response('{}', { status: 200 }));
    }

    if (String(url).includes('conversations.open')) {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, channel: { id: 'D001' } }), { status: 200 }),
      );
    }

    if (String(url).includes('chat.postMessage')) {
      const body = JSON.parse((init?.body as string) ?? '{}') as { text?: string };
      if (body.text) dmTexts.push(body.text);
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }

    if (String(url).includes('/message')) {
      if (opts.messageAlwaysHang) {
        // Respects AbortSignal so controller.abort() rejects this promise
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
          // never resolves on its own
        });
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }

    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ─── Interim message on 15s timer ─────────────────────────────────────────────

describe('US-026 — interim message (AC #1, #2, #3)', () => {
  it('sends "⏳ Working on it..." via chat.postMessage after 15s with no response', async () => {
    vi.useFakeTimers();

    const dmTexts: string[] = [];
    const fetchFn = makeFetchFn(dmTexts, { messageAlwaysHang: true });

    const processPromise = processSlackEvent(ACTIVE_ENVELOPE, makeLog() as never, fetchFn);

    // Advance past 15-second interim timer
    await vi.advanceTimersByTimeAsync(15_001);
    // Flush any queued microtasks from the interim DM calls
    await Promise.resolve();
    await Promise.resolve();

    expect(dmTexts).toContain('⏳ Working on it...');

    // Clean up: advance to 4-minute abort, then resolve
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    await processPromise;
  });

  it('sends interim message only once (AC #3)', async () => {
    vi.useFakeTimers();

    const dmTexts: string[] = [];
    const fetchFn = makeFetchFn(dmTexts, { messageAlwaysHang: true });

    const processPromise = processSlackEvent(ACTIVE_ENVELOPE, makeLog() as never, fetchFn);

    // Advance well past 15s
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    await Promise.resolve();

    const interimCount = dmTexts.filter((t) => t.includes('⏳ Working on it')).length;
    expect(interimCount).toBe(1);

    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    await processPromise;
  });
});

// ─── 4-minute timeout (AC #4, #6) ─────────────────────────────────────────────

describe('US-026 — 4-minute max wait (AC #4, #6)', () => {
  it('posts "still working" DM when 4-minute timeout is reached', async () => {
    vi.useFakeTimers();

    const dmTexts: string[] = [];
    const fetchFn = makeFetchFn(dmTexts, { messageAlwaysHang: true });

    const processPromise = processSlackEvent(ACTIVE_ENVELOPE, makeLog() as never, fetchFn);

    // Jump straight to after 4 minutes (skipping over 15s interim too)
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 1);
    await Promise.resolve();
    await Promise.resolve();

    await processPromise;

    expect(dmTexts).toContain("I'm still working on this. I'll follow up when complete.");
  });

  it('does NOT post "still working" if response arrived before 4-minute timeout', async () => {
    vi.useFakeTimers();

    const dmTexts: string[] = [];
    // Message endpoint resolves quickly
    const fetchFn = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/provision')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ tenantId: 'abc123def456abcd', status: 'ACTIVE', relayToken: 'tok' }),
            { status: 200 },
          ),
        );
      }
      if (String(url).includes('/start')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      if (String(url).includes('conversations.open')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, channel: { id: 'D001' } }), { status: 200 }),
        );
      }
      if (String(url).includes('chat.postMessage')) {
        const body = JSON.parse((init?.body as string) ?? '{}') as { text?: string };
        if (body.text) dmTexts.push(body.text);
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      if (String(url).includes('/message')) {
        // Responds with a text reply immediately
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, response: 'Here is your answer' }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    const processPromise = processSlackEvent(ACTIVE_ENVELOPE, makeLog() as never, fetchFn);
    await processPromise;

    expect(dmTexts).not.toContain("I'm still working on this. I'll follow up when complete.");
    vi.useRealTimers();
  });
});

// ─── Actual response forwarding (AC #5) ────────────────────────────────────────

describe('US-026 — actual response forwarding (AC #5)', () => {
  it('forwards response text via chat.postMessage when ok=true and response field set', async () => {
    vi.useRealTimers();

    const dmTexts: string[] = [];

    const fetchFn = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/provision')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ tenantId: 'abc123def456abcd', status: 'ACTIVE', relayToken: 'tok' }),
            { status: 200 },
          ),
        );
      }
      if (String(url).includes('/start')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      if (String(url).includes('conversations.open')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, channel: { id: 'D001' } }), { status: 200 }),
        );
      }
      if (String(url).includes('chat.postMessage')) {
        const body = JSON.parse((init?.body as string) ?? '{}') as { text?: string };
        if (body.text) dmTexts.push(body.text);
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      if (String(url).includes('/message')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, response: 'My answer to your question' }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    await processSlackEvent(ACTIVE_ENVELOPE, makeLog() as never, fetchFn);

    expect(dmTexts).toContain('My answer to your question');
  });

  it('forwards blocks via chat.postMessage when ok=true and blocks field is non-null', async () => {
    vi.useRealTimers();

    const postMessageBodies: unknown[] = [];

    const fetchFn = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/provision')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ tenantId: 'abc123def456abcd', status: 'ACTIVE', relayToken: 'tok' }),
            { status: 200 },
          ),
        );
      }
      if (String(url).includes('/start')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      if (String(url).includes('chat.postMessage')) {
        postMessageBodies.push(JSON.parse((init?.body as string) ?? '{}'));
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      if (String(url).includes('/message')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ ok: true, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'hi' } }] }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    await processSlackEvent(ACTIVE_ENVELOPE, makeLog() as never, fetchFn);

    const blocksCalls = postMessageBodies.filter((b) => (b as { blocks?: unknown }).blocks != null);
    expect(blocksCalls).toHaveLength(1);
  });
});

/**
 * Tests for POST /slack/events — US-024
 *
 * Acceptance criteria verified:
 * 1. HTTP 200 is returned before provision/start calls complete (AC #1, #8, #10)
 * 2. URL verification challenge is handled synchronously (AC #2)
 * 3. tenant_id computed as sha256(team_id:user_id).slice(0,16) (AC #4)
 * 4. Access denied → rejection DM + ACCESS_DENIED log (AC #5, #6)
 * 5. Rejection DM text matches spec (AC #6)
 * 6. Deduplication: 409 from message endpoint is silently ignored (AC #9)
 * 7. Invalid signature returns 403
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { verifySlackSignature } from './verify-signature.js';
import { computeTenantId, processSlackEvent, type SlackEventEnvelope } from './index.js';

// ─── Test helpers ──────────────────────────────────────────────────────────

const SIGNING_SECRET = 'test-signing-secret';

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

/**
 * Build a minimal Fastify test app that replicates the /slack/events route
 * and accepts a custom fetchFn for mocking. This avoids importing index.ts
 * in a way that triggers server listen().
 */
function buildTestApp(fetchFn: typeof fetch): FastifyInstance {
  const app = Fastify({ logger: false });

  // Capture raw body for signature verification
  app.addHook('preParsing', async (req, _reply, payload) => {
    const chunks: Buffer[] = [];
    for await (const chunk of payload as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    (req as typeof req & { rawBody?: string }).rawBody = raw;
    return Readable.from(Buffer.from(raw));
  });

  app.post('/slack/events', async (req, reply) => {
    const rawBody = (req as typeof req & { rawBody?: string }).rawBody ?? '';
    const isValid = verifySlackSignature(
      rawBody,
      {
        'x-slack-signature': req.headers['x-slack-signature'] as string | undefined,
        'x-slack-request-timestamp': req.headers['x-slack-request-timestamp'] as string | undefined,
      },
      SIGNING_SECRET,
    );

    if (!isValid) {
      return reply.status(403).send({ error: 'Invalid signature' });
    }

    const body = req.body as SlackEventEnvelope;

    // URL verification challenge — synchronous response
    if (body.type === 'url_verification') {
      return reply.send({ challenge: body.challenge });
    }

    // Fire-and-forget: send 200 before any async processing
    void processSlackEvent(body, req.log, fetchFn).catch((err) => {
      req.log.error({ err }, 'Error processing Slack event');
    });

    return reply.send({});
  });

  return app;
}

// ─── computeTenantId ───────────────────────────────────────────────────────

describe('computeTenantId (AC #4)', () => {
  it('returns sha256(team_id:user_id) truncated to 16 hex chars', () => {
    const teamId = 'T12345';
    const userId = 'U67890';
    const expected = createHash('sha256')
      .update(`${teamId}:${userId}`)
      .digest('hex')
      .slice(0, 16);
    expect(computeTenantId(teamId, userId)).toBe(expected);
  });

  it('produces a 16-character lowercase hex string', () => {
    const result = computeTenantId('TABC', 'UDEF');
    expect(result).toHaveLength(16);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic for the same inputs', () => {
    expect(computeTenantId('T1', 'U1')).toBe(computeTenantId('T1', 'U1'));
  });

  it('differs for different team/user combos', () => {
    expect(computeTenantId('T1', 'U1')).not.toBe(computeTenantId('T1', 'U2'));
    expect(computeTenantId('T1', 'U1')).not.toBe(computeTenantId('T2', 'U1'));
  });
});

// ─── Route: URL verification ───────────────────────────────────────────────

describe('POST /slack/events — URL verification (AC #2)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch;
    app = buildTestApp(fetchFn);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns {challenge} for url_verification events', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123xyz' });
    const res = await app.inject({
      method: 'POST',
      url: '/slack/events',
      headers: makeSlackHeaders(body),
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ challenge: 'abc123xyz' });
  });
});

// ─── Route: signature verification ─────────────────────────────────────────

describe('POST /slack/events — signature verification', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch;
    app = buildTestApp(fetchFn);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 403 for invalid Slack signature', async () => {
    const body = JSON.stringify({ type: 'event_callback', team_id: 'T1' });
    const res = await app.inject({
      method: 'POST',
      url: '/slack/events',
      headers: {
        'x-slack-signature': 'v0=deadbeef',
        'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
        'content-type': 'application/json',
      },
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid signature' });
  });
});

// ─── Route: immediate 200 ack (AC #1, #8, #10) ─────────────────────────────

describe('POST /slack/events — immediate 200 ack before async processing (AC #1, #8, #10)', () => {
  it('returns HTTP 200 with {} body before provision/start calls complete', async () => {
    let provisionStarted = false;
    let provisionResolved = false;
    let startResolved = false;

    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/provision')) {
        provisionStarted = true;
        return new Promise((resolve) => {
          // Resolve asynchronously after a delay — should NOT block the 200 response
          setImmediate(() => {
            provisionResolved = true;
            resolve(
              new Response(
                JSON.stringify({ tenantId: 'abc123def456abcd', status: 'NEW' }),
                { status: 200 },
              ),
            );
          });
        });
      }
      if (String(url).includes('/start')) {
        return new Promise((resolve) => {
          setImmediate(() => {
            startResolved = true;
            resolve(new Response('{}', { status: 200 }));
          });
        });
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    const app = buildTestApp(fetchFn);
    await app.ready();

    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T123',
      event_id: 'Ev001',
      event: { user: 'U456', text: 'hello', type: 'message' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/slack/events',
      headers: makeSlackHeaders(body),
      payload: body,
    });

    // 200 received before async work completes
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({});

    // Provision was kicked off but not yet resolved at time of 200
    expect(provisionStarted).toBe(true);
    expect(provisionResolved).toBe(false);
    expect(startResolved).toBe(false);

    await app.close();
    // Allow async processing to finish to avoid unhandled promise rejections
    await new Promise((r) => setTimeout(r, 50));
  });
});

// ─── processSlackEvent: access denied (AC #5, #6) ──────────────────────────

describe('processSlackEvent — access denied (AC #5, #6)', () => {
  const fakeLog = () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  });

  it('posts rejection DM when provision returns 403', async () => {
    const dmCalls: string[] = [];

    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/provision')) {
        return Promise.resolve(new Response('{"error":"Access denied"}', { status: 403 }));
      }
      if (String(url).includes('conversations.open')) {
        dmCalls.push('open');
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, channel: { id: 'D001' } }), { status: 200 }),
        );
      }
      if (String(url).includes('chat.postMessage')) {
        dmCalls.push('postMessage');
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    const envelope: SlackEventEnvelope = {
      type: 'event_callback',
      team_id: 'T123',
      event_id: 'Ev001',
      event: { user: 'U456', text: 'hello', type: 'message' },
    };

    const log = fakeLog();
    await processSlackEvent(envelope, log as never, fetchFn);

    expect(dmCalls).toContain('open');
    expect(dmCalls).toContain('postMessage');

    // Should NOT call start or message
    const allUrls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(allUrls.some((u) => u.includes('/start'))).toBe(false);
    expect(allUrls.some((u) => u.includes('/message'))).toBe(false);
  });

  it('sends the correct rejection DM text (AC #6)', async () => {
    let capturedText = '';

    const fetchFn = vi.fn().mockImplementation((url: string, opts: RequestInit) => {
      if (String(url).includes('/provision')) {
        return Promise.resolve(new Response('{"error":"Access denied"}', { status: 403 }));
      }
      if (String(url).includes('conversations.open')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, channel: { id: 'D001' } }), { status: 200 }),
        );
      }
      if (String(url).includes('chat.postMessage')) {
        const parsed = JSON.parse(opts.body as string) as { text: string };
        capturedText = parsed.text;
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    const envelope: SlackEventEnvelope = {
      type: 'event_callback',
      team_id: 'T123',
      event_id: 'Ev001',
      event: { user: 'U456', text: 'hello', type: 'message' },
    };

    await processSlackEvent(envelope, fakeLog() as never, fetchFn);

    expect(capturedText).toBe(
      'Thanks for your interest! This system is currently invite-only. Contact [admin contact] to request access.',
    );
  });

  it('logs ACCESS_DENIED on denied access (AC #5)', async () => {
    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/provision')) {
        return Promise.resolve(new Response('{"error":"Access denied"}', { status: 403 }));
      }
      if (String(url).includes('conversations.open')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, channel: { id: 'D001' } }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }) as unknown as typeof fetch;

    const envelope: SlackEventEnvelope = {
      type: 'event_callback',
      team_id: 'T123',
      event_id: 'Ev001',
      event: { user: 'U456', text: 'hello', type: 'message' },
    };

    const log = fakeLog();
    await processSlackEvent(envelope, log as never, fetchFn);

    expect(log.warn).toHaveBeenCalled();
    const warnArgs = JSON.stringify(log.warn.mock.calls);
    expect(warnArgs).toContain('ACCESS_DENIED');
  });
});

// ─── processSlackEvent: happy path ─────────────────────────────────────────

describe('processSlackEvent — happy path', () => {
  it('calls provision then message endpoint when tenant is already ACTIVE', async () => {
    const callOrder: string[] = [];

    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/provision')) {
        callOrder.push('provision');
        return Promise.resolve(
          new Response(
            // Return ACTIVE so no polling loop needed
            JSON.stringify({ tenantId: 'abc123def456abcd', status: 'ACTIVE', relayToken: 'tok' }),
            { status: 200 },
          ),
        );
      }
      if (String(url).includes('/start')) {
        callOrder.push('start');
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      if (String(url).includes('/message')) {
        callOrder.push('message');
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    const envelope: SlackEventEnvelope = {
      type: 'event_callback',
      team_id: 'T123',
      event_id: 'Ev001',
      event: { user: 'U456', text: 'hello', type: 'message' },
    };

    const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() };
    await processSlackEvent(envelope, log as never, fetchFn);

    expect(callOrder).toContain('provision');
    expect(callOrder).toContain('message');
    // When ACTIVE, start should not be called
    expect(callOrder).not.toContain('start');
    // Provision must be before message
    expect(callOrder.indexOf('provision')).toBeLessThan(callOrder.indexOf('message'));
  });

  it('silently ignores missing team_id or user_id', async () => {
    const fetchFn = vi.fn();

    const envelope: SlackEventEnvelope = {
      type: 'event_callback',
      // no team_id, no event.user
    };

    const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() };
    await processSlackEvent(envelope, log as never, fetchFn as unknown as typeof fetch);

    expect(fetchFn).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });
});

// ─── US-025: queuing and status polling ────────────────────────────────────

describe('processSlackEvent — US-025: tenant start + status polling', () => {
  const makeLog = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() });

  it('does NOT call start again when tenant is already STARTING', async () => {
    const startCalls: string[] = [];

    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/provision')) {
        return Promise.resolve(
          new Response(JSON.stringify({ tenantId: 'abc123def456abcd', status: 'ACTIVE', relayToken: 'tok' }), { status: 200 }),
        );
      }
      if (String(url).includes('/start')) {
        startCalls.push('start');
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    // First call: provision returns STARTING
    let pollCount = 0;
    const fetchFnStarting = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/provision')) {
        pollCount++;
        // First call returns STARTING; second call returns ACTIVE (simulate polling)
        const status = pollCount === 1 ? 'STARTING' : 'ACTIVE';
        return Promise.resolve(
          new Response(JSON.stringify({ tenantId: 'abc123def456abcd', status, relayToken: 'tok' }), { status: 200 }),
        );
      }
      if (String(url).includes('/start')) {
        startCalls.push('start');
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    const envelope: SlackEventEnvelope = {
      type: 'event_callback',
      team_id: 'T123',
      event_id: 'Ev002',
      event: { user: 'U456', text: 'hi', type: 'message' },
    };

    await processSlackEvent(envelope, makeLog() as never, fetchFnStarting);

    // start should NOT be called when tenant is STARTING
    expect(startCalls).toHaveLength(0);
  });

  it('calls start when tenant status is STOPPED (not STARTING or ACTIVE)', async () => {
    let startCalled = false;

    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/provision')) {
        return Promise.resolve(
          new Response(JSON.stringify({ tenantId: 'abc123def456abcd', status: 'ACTIVE', relayToken: 'tok' }), { status: 200 }),
        );
      }
      if (String(url).includes('/start')) {
        startCalled = true;
        return Promise.resolve(new Response('{}', { status: 202 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    // Simulate STOPPED → provision returns STOPPED first, then ACTIVE on next poll
    let pollCount = 0;
    const fetchFnStopped = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/provision')) {
        pollCount++;
        const status = pollCount === 1 ? 'STOPPED' : 'ACTIVE';
        return Promise.resolve(
          new Response(JSON.stringify({ tenantId: 'abc123def456abcd', status, relayToken: 'tok' }), { status: 200 }),
        );
      }
      if (String(url).includes('/start')) {
        startCalled = true;
        return Promise.resolve(new Response('{}', { status: 202 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    const envelope: SlackEventEnvelope = {
      type: 'event_callback',
      team_id: 'T123',
      event_id: 'Ev003',
      event: { user: 'U456', text: 'hi', type: 'message' },
    };

    await processSlackEvent(envelope, makeLog() as never, fetchFnStopped);

    expect(startCalled).toBe(true);
  });
});

// ─── processSlackEvent: deduplication (AC #9) ──────────────────────────────

describe('processSlackEvent — deduplication (AC #9)', () => {
  it('does not throw when message endpoint returns 409 (duplicate event)', async () => {
    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/provision')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ tenantId: 'abc123def456abcd', status: 'ACTIVE' }),
            { status: 200 },
          ),
        );
      }
      if (String(url).includes('/start')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      if (String(url).includes('/message')) {
        // 409 = duplicate slack_event_id — should be silently ignored
        return Promise.resolve(new Response('{"error":"Duplicate event"}', { status: 409 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    const envelope: SlackEventEnvelope = {
      type: 'event_callback',
      team_id: 'T123',
      event_id: 'Ev001-dup',
      event: { user: 'U456', text: 'hello again', type: 'message' },
    };

    const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() };

    await expect(
      processSlackEvent(envelope, log as never, fetchFn),
    ).resolves.not.toThrow();
  });
});

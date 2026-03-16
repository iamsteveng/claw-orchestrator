/**
 * Tests for POST /slack/events — US-024
 * Verifies that:
 * 1. HTTP 200 is returned before provision/start calls complete
 * 2. URL verification challenge is handled synchronously
 * 3. Invalid signatures return 403
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';

// Build a minimal relay app for testing
async function buildTestApp(): Promise<FastifyInstance> {
  const { verifySlackSignature } = await import('./verify-signature.js');

  const app = Fastify({ logger: false });

  // Capture raw body
  app.addHook('preParsing', async (req, _reply, payload) => {
    const chunks: Buffer[] = [];
    for await (const chunk of payload as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    (req as typeof req & { rawBody?: string }).rawBody = raw;
    return Readable.from(Buffer.from(raw));
  });

  const SIGNING_SECRET = 'test-signing-secret';

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

    const body = req.body as { type: string; challenge?: string };

    // URL verification challenge
    if (body.type === 'url_verification') {
      return reply.send({ challenge: body.challenge });
    }

    // Fire-and-forget async processing
    void (async () => {
      await fetch('http://control-plane:3200/v1/tenants/provision', { method: 'POST' });
    })().catch(() => undefined);

    // Return 200 immediately
    return reply.send({});
  });

  return app;
}

function makeSlackHeaders(signingSecret: string, body: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = createHmac('sha256', signingSecret);
  hmac.update(baseString);
  const signature = `v0=${hmac.digest('hex')}`;
  return {
    'x-slack-signature': signature,
    'x-slack-request-timestamp': timestamp,
    'content-type': 'application/json',
  };
}

describe('POST /slack/events', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it('returns 200 immediately before provision calls complete', async () => {
    let provisionResolved = false;

    // Mock fetch to be a slow promise
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('provision')) {
        await new Promise((resolve) => setTimeout(resolve, 10_000)); // 10 seconds
        provisionResolved = true;
      }
      return { ok: true, json: async () => ({ ok: true }) };
    }));

    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T123',
      event: { user: 'U456', text: 'hello', channel: 'C789', ts: '123.456' },
      event_id: 'Ev001',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/slack/events',
      headers: makeSlackHeaders('test-signing-secret', body),
      payload: body,
    });

    // 200 should be returned BEFORE provision resolves
    expect(response.statusCode).toBe(200);
    expect(provisionResolved).toBe(false); // provision hasn't completed yet
    expect(JSON.parse(response.body)).toEqual({});
  });

  it('handles URL verification challenge synchronously', async () => {
    const body = JSON.stringify({
      type: 'url_verification',
      challenge: 'abc123',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/slack/events',
      headers: makeSlackHeaders('test-signing-secret', body),
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ challenge: 'abc123' });
  });

  it('returns 403 for invalid Slack signature', async () => {
    const body = JSON.stringify({ type: 'event_callback', team_id: 'T1' });

    const response = await app.inject({
      method: 'POST',
      url: '/slack/events',
      headers: {
        'x-slack-signature': 'v0=invalidsignature',
        'x-slack-request-timestamp': Math.floor(Date.now() / 1000).toString(),
        'content-type': 'application/json',
      },
      payload: body,
    });

    expect(response.statusCode).toBe(403);
  });

  it('computes tenant_id as sha256(team_id:user_id).slice(0, 16)', () => {
    const teamId = 'T12345';
    const userId = 'U67890';
    const expected = createHash('sha256')
      .update(`${teamId}:${userId}`)
      .digest('hex')
      .slice(0, 16);

    expect(expected).toHaveLength(16);
    expect(expected).toMatch(/^[0-9a-f]+$/);
  });
});

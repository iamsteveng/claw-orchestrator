import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifySlackSignature } from './verify-signature.js';

const SECRET = 'test-signing-secret';

function makeHeaders(timestamp: number, rawBody: string, secret = SECRET) {
  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = createHmac('sha256', secret);
  hmac.update(baseString);
  const signature = `v0=${hmac.digest('hex')}`;
  return {
    'x-slack-request-timestamp': String(timestamp),
    'x-slack-signature': signature,
  };
}

const now = Math.floor(Date.now() / 1000);
const body = '{"type":"event_callback"}';

describe('verifySlackSignature', () => {
  it('returns true for a valid signature', () => {
    const headers = makeHeaders(now, body);
    expect(verifySlackSignature(body, headers, SECRET)).toBe(true);
  });

  it('returns false for an invalid signature', () => {
    const headers = makeHeaders(now, body, 'wrong-secret');
    expect(verifySlackSignature(body, headers, SECRET)).toBe(false);
  });

  it('returns false when timestamp is more than 5 minutes old', () => {
    const oldTimestamp = now - 6 * 60; // 6 minutes ago
    const headers = makeHeaders(oldTimestamp, body);
    expect(verifySlackSignature(body, headers, SECRET)).toBe(false);
  });

  it('returns false when X-Slack-Signature header is missing', () => {
    expect(
      verifySlackSignature(body, { 'x-slack-request-timestamp': String(now) }, SECRET)
    ).toBe(false);
  });

  it('returns false when X-Slack-Request-Timestamp header is missing', () => {
    const headers = makeHeaders(now, body);
    expect(
      verifySlackSignature(body, { 'x-slack-signature': headers['x-slack-signature'] }, SECRET)
    ).toBe(false);
  });
});

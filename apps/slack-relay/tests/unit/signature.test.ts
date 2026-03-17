import { describe, it, expect } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import { verifySlackSignature } from '../../src/verify-signature.js';
import { computeTenantId } from '../../src/index.js';

const SECRET = 'test-signing-secret';

function makeSignature(timestamp: string, body: string): string {
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = createHmac('sha256', SECRET);
  hmac.update(baseString);
  return `v0=${hmac.digest('hex')}`;
}

describe('Slack signature verification', () => {
  it('returns true for a valid signature', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = '{"event":"test"}';
    const sig = makeSignature(ts, body);

    const result = verifySlackSignature(body, {
      'x-slack-signature': sig,
      'x-slack-request-timestamp': ts,
    }, SECRET);

    expect(result).toBe(true);
  });

  it('returns false for an invalid signature', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = '{"event":"test"}';

    const result = verifySlackSignature(body, {
      'x-slack-signature': 'v0=invalidsignature',
      'x-slack-request-timestamp': ts,
    }, SECRET);

    expect(result).toBe(false);
  });

  it('returns false for an expired timestamp (replay attack)', () => {
    const ts = String(Math.floor(Date.now() / 1000) - 6 * 60); // 6 minutes ago
    const body = '{"event":"test"}';
    const sig = makeSignature(ts, body);

    const result = verifySlackSignature(body, {
      'x-slack-signature': sig,
      'x-slack-request-timestamp': ts,
    }, SECRET);

    expect(result).toBe(false);
  });

  it('returns false when headers are missing', () => {
    const result = verifySlackSignature('body', {}, SECRET);
    expect(result).toBe(false);
  });
});

describe('Tenant ID computation', () => {
  it('computes sha256(team_id:user_id).slice(0,16)', () => {
    const teamId = 'T123';
    const userId = 'U456';
    const expected = createHash('sha256')
      .update(`${teamId}:${userId}`)
      .digest('hex')
      .slice(0, 16);

    const result = computeTenantId(teamId, userId);

    expect(result).toBe(expected);
    expect(result).toHaveLength(16);
  });

  it('produces different IDs for different team/user combinations', () => {
    const id1 = computeTenantId('T1', 'U1');
    const id2 = computeTenantId('T2', 'U1');
    const id3 = computeTenantId('T1', 'U2');

    expect(id1).not.toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id2).not.toBe(id3);
  });

  it('is deterministic (same inputs produce same ID)', () => {
    const id1 = computeTenantId('T123', 'U456');
    const id2 = computeTenantId('T123', 'U456');
    expect(id1).toBe(id2);
  });
});

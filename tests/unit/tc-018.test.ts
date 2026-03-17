/**
 * TC-018: Tenant ID computation → sha256(team:user).slice(0,16)
 *
 * Verifies that computeTenantId produces a deterministic, collision-resistant
 * 16-character hex ID from sha256(teamId:userId).
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { computeTenantId } from '../../apps/slack-relay/src/index.js';

describe('TC-018: Tenant ID computation → sha256(team:user).slice(0,16)', () => {
  it('TC-018: computes sha256(T12345:U67890).slice(0,16) correctly', () => {
    const expected = createHash('sha256')
      .update('T12345:U67890')
      .digest('hex')
      .slice(0, 16);
    expect(computeTenantId('T12345', 'U67890')).toBe(expected);
  });

  it('TC-018: result is exactly 16 hex characters', () => {
    const result = computeTenantId('T12345', 'U67890');
    expect(result).toHaveLength(16);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it('TC-018: is deterministic for same inputs', () => {
    const id1 = computeTenantId('T12345', 'U67890');
    const id2 = computeTenantId('T12345', 'U67890');
    expect(id1).toBe(id2);
  });

  it('TC-018: different users produce different IDs', () => {
    const id1 = computeTenantId('T12345', 'U67890');
    const id2 = computeTenantId('T12345', 'U99999');
    expect(id1).not.toBe(id2);
  });

  it('TC-018: different teams produce different IDs', () => {
    const id1 = computeTenantId('T12345', 'U67890');
    const id2 = computeTenantId('T99999', 'U67890');
    expect(id1).not.toBe(id2);
  });
});

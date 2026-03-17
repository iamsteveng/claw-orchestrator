import { describe, it, expect } from 'vitest';
import { TenantStatus } from '@claw/shared-types';

/**
 * Valid tenant state transitions as defined in SPEC.md.
 *
 * Provisioning flow:    NEW → PROVISIONING → ACTIVE | FAILED
 * Wake-up flow:         STOPPED → STARTING → ACTIVE | UNHEALTHY
 * Stop flow:            ACTIVE → STOPPED
 *                       STARTING → STOPPED
 * Recovery flow:        UNHEALTHY → ACTIVE (auto-recovery)
 *                       UNHEALTHY → STOPPED (admin stop)
 * Deletion flow:        ANY → DELETING
 */
const VALID_TRANSITIONS: Record<TenantStatus, TenantStatus[]> = {
  [TenantStatus.NEW]: [TenantStatus.PROVISIONING],
  [TenantStatus.PROVISIONING]: [TenantStatus.ACTIVE, TenantStatus.FAILED, TenantStatus.DELETING],
  [TenantStatus.STARTING]: [TenantStatus.ACTIVE, TenantStatus.UNHEALTHY, TenantStatus.STOPPED, TenantStatus.DELETING],
  [TenantStatus.ACTIVE]: [TenantStatus.STOPPED, TenantStatus.UNHEALTHY, TenantStatus.DELETING],
  [TenantStatus.STOPPED]: [TenantStatus.STARTING, TenantStatus.DELETING],
  [TenantStatus.UNHEALTHY]: [TenantStatus.ACTIVE, TenantStatus.STOPPED, TenantStatus.DELETING],
  [TenantStatus.FAILED]: [TenantStatus.PROVISIONING, TenantStatus.DELETING],
  [TenantStatus.DELETING]: [],
};

function isValidTransition(from: TenantStatus, to: TenantStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

describe('Tenant state transitions', () => {
  describe('valid transitions', () => {
    it('NEW → PROVISIONING', () => {
      expect(isValidTransition(TenantStatus.NEW, TenantStatus.PROVISIONING)).toBe(true);
    });

    it('PROVISIONING → ACTIVE (successful provisioning)', () => {
      expect(isValidTransition(TenantStatus.PROVISIONING, TenantStatus.ACTIVE)).toBe(true);
    });

    it('PROVISIONING → FAILED (provisioning error)', () => {
      expect(isValidTransition(TenantStatus.PROVISIONING, TenantStatus.FAILED)).toBe(true);
    });

    it('STOPPED → STARTING (wake-up)', () => {
      expect(isValidTransition(TenantStatus.STOPPED, TenantStatus.STARTING)).toBe(true);
    });

    it('STARTING → ACTIVE (health check passes)', () => {
      expect(isValidTransition(TenantStatus.STARTING, TenantStatus.ACTIVE)).toBe(true);
    });

    it('STARTING → UNHEALTHY (health poll timeout)', () => {
      expect(isValidTransition(TenantStatus.STARTING, TenantStatus.UNHEALTHY)).toBe(true);
    });

    it('ACTIVE → STOPPED (explicit stop)', () => {
      expect(isValidTransition(TenantStatus.ACTIVE, TenantStatus.STOPPED)).toBe(true);
    });

    it('ACTIVE → UNHEALTHY (health check fails)', () => {
      expect(isValidTransition(TenantStatus.ACTIVE, TenantStatus.UNHEALTHY)).toBe(true);
    });

    it('UNHEALTHY → ACTIVE (auto-recovery succeeds)', () => {
      expect(isValidTransition(TenantStatus.UNHEALTHY, TenantStatus.ACTIVE)).toBe(true);
    });

    it('UNHEALTHY → STOPPED (admin stop)', () => {
      expect(isValidTransition(TenantStatus.UNHEALTHY, TenantStatus.STOPPED)).toBe(true);
    });

    it('FAILED → PROVISIONING (retry provisioning)', () => {
      expect(isValidTransition(TenantStatus.FAILED, TenantStatus.PROVISIONING)).toBe(true);
    });

    it('ANY → DELETING (soft delete)', () => {
      const statuses: TenantStatus[] = [
        TenantStatus.PROVISIONING,
        TenantStatus.STARTING,
        TenantStatus.ACTIVE,
        TenantStatus.STOPPED,
        TenantStatus.UNHEALTHY,
        TenantStatus.FAILED,
      ];
      for (const status of statuses) {
        expect(isValidTransition(status, TenantStatus.DELETING)).toBe(true);
      }
    });
  });

  describe('invalid transitions', () => {
    it('NEW → ACTIVE is not valid (must go through PROVISIONING)', () => {
      expect(isValidTransition(TenantStatus.NEW, TenantStatus.ACTIVE)).toBe(false);
    });

    it('NEW → STOPPED is not valid', () => {
      expect(isValidTransition(TenantStatus.NEW, TenantStatus.STOPPED)).toBe(false);
    });

    it('ACTIVE → PROVISIONING is not valid', () => {
      expect(isValidTransition(TenantStatus.ACTIVE, TenantStatus.PROVISIONING)).toBe(false);
    });

    it('STOPPED → ACTIVE is not valid (must go through STARTING)', () => {
      expect(isValidTransition(TenantStatus.STOPPED, TenantStatus.ACTIVE)).toBe(false);
    });

    it('DELETING → ACTIVE is not valid (terminal state)', () => {
      expect(isValidTransition(TenantStatus.DELETING, TenantStatus.ACTIVE)).toBe(false);
    });

    it('DELETING → STOPPED is not valid (terminal state)', () => {
      expect(isValidTransition(TenantStatus.DELETING, TenantStatus.STOPPED)).toBe(false);
    });

    it('FAILED → ACTIVE is not valid (must re-provision)', () => {
      expect(isValidTransition(TenantStatus.FAILED, TenantStatus.ACTIVE)).toBe(false);
    });

    it('UNHEALTHY → STARTING is not valid', () => {
      expect(isValidTransition(TenantStatus.UNHEALTHY, TenantStatus.STARTING)).toBe(false);
    });
  });
});

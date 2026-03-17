import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isAllowed } from './allowlist.js';

function makePrisma(findFirstResult: unknown = null) {
  return {
    allowlist: {
      findFirst: vi.fn().mockResolvedValue(findFirstResult),
    },
  } as unknown as import('@prisma/client').PrismaClient;
}

describe('isAllowed', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true for user-level allow entry', async () => {
    const prisma = makePrisma({ id: '1', slack_team_id: 'T1', slack_user_id: 'U1', revoked_at: null });
    expect(await isAllowed(prisma, 'T1', 'U1')).toBe(true);
    expect(prisma.allowlist.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ slack_team_id: 'T1', revoked_at: null }),
    });
  });

  it('returns true for team-level allow entry (null user)', async () => {
    const prisma = makePrisma({ id: '2', slack_team_id: 'T1', slack_user_id: null, revoked_at: null });
    expect(await isAllowed(prisma, 'T1', 'U2')).toBe(true);
  });

  it('returns false when entry is revoked', async () => {
    // findFirst returns null because revoked_at IS NOT NULL is filtered out
    const prisma = makePrisma(null);
    expect(await isAllowed(prisma, 'T1', 'U1')).toBe(false);
  });

  it('returns false when no entry exists', async () => {
    const prisma = makePrisma(null);
    expect(await isAllowed(prisma, 'T99', 'U99')).toBe(false);
  });
});

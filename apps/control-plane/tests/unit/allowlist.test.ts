import { describe, it, expect, vi } from 'vitest';
import { isAllowed } from '../../src/allowlist.js';
import { mockPrismaClient } from '@claw/test-utils';

describe('Allowlist query logic', () => {
  it('allows user when a user-specific entry exists', async () => {
    const prisma = mockPrismaClient();
    prisma.allowlist.findFirst = vi.fn().mockResolvedValue({ id: '1', slack_user_id: 'U456' });

    const result = await isAllowed(prisma, 'T123', 'U456');

    expect(result).toBe(true);
    expect(prisma.allowlist.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          slack_team_id: 'T123',
          revoked_at: null,
        }),
      }),
    );
  });

  it('allows user when a team-level entry exists (slack_user_id=null)', async () => {
    const prisma = mockPrismaClient();
    prisma.allowlist.findFirst = vi.fn().mockResolvedValue({ id: '2', slack_user_id: null });

    const result = await isAllowed(prisma, 'T123', 'U999');

    expect(result).toBe(true);
  });

  it('denies user when no entry exists', async () => {
    const prisma = mockPrismaClient();
    prisma.allowlist.findFirst = vi.fn().mockResolvedValue(null);

    const result = await isAllowed(prisma, 'T123', 'U000');

    expect(result).toBe(false);
  });

  it('denies user when entry is revoked (revoked_at is set)', async () => {
    const prisma = mockPrismaClient();
    // When revoked_at is set, the WHERE clause excludes it (revoked_at: null)
    prisma.allowlist.findFirst = vi.fn().mockResolvedValue(null);

    const result = await isAllowed(prisma, 'T123', 'U456');

    expect(result).toBe(false);
  });
});

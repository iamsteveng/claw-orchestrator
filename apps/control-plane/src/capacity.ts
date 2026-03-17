import type { PrismaClient } from '@prisma/client';
import { TenantStatus } from '@claw/shared-types';

/**
 * Returns the count of currently ACTIVE tenants (non-deleted).
 */
export async function getActiveTenantCount(prisma: PrismaClient): Promise<number> {
  return prisma.tenant.count({
    where: { status: TenantStatus.ACTIVE, deleted_at: null },
  });
}

/**
 * Returns true if starting a new tenant would exceed the capacity cap.
 */
export async function isAtCapacity(prisma: PrismaClient, maxActiveTenants: number): Promise<boolean> {
  const count = await getActiveTenantCount(prisma);
  return count >= maxActiveTenants;
}

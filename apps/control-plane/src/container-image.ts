import type { PrismaClient } from '@prisma/client';
import { controlPlaneConfig } from '@claw/shared-config/control-plane';
import { randomUUID } from 'node:crypto';

/**
 * Returns the current default image tag from container_images.
 * Falls back to TENANT_IMAGE env var if no default is set in DB.
 */
export async function getDefaultImage(prisma: PrismaClient): Promise<string> {
  const row = await prisma.containerImage.findFirst({
    where: { is_default: 1 },
  });
  return row?.tag ?? controlPlaneConfig.TENANT_IMAGE;
}

/**
 * Seeds an initial container_images row if none exists.
 * Called at startup.
 */
export async function seedDefaultImage(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.containerImage.findFirst({
    where: { is_default: 1 },
  });
  if (!existing) {
    await prisma.containerImage.create({
      data: {
        id: randomUUID(),
        tag: controlPlaneConfig.TENANT_IMAGE,
        is_default: 1,
        created_at: Date.now(),
      },
    });
  }
}

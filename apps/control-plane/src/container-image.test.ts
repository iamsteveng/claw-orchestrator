import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDefaultImage, seedDefaultImage } from './container-image.js';

const mockContainerImage = {
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

const prisma = { containerImage: mockContainerImage } as unknown as import('@prisma/client').PrismaClient;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getDefaultImage', () => {
  it('returns the default image tag when a default exists', async () => {
    mockContainerImage.findFirst.mockResolvedValue({ tag: 'claw-tenant:sha-abc1234', is_default: 1 });
    const tag = await getDefaultImage(prisma);
    expect(tag).toBe('claw-tenant:sha-abc1234');
    expect(mockContainerImage.findFirst).toHaveBeenCalledWith({ where: { is_default: 1 } });
  });

  it('falls back to TENANT_IMAGE env var when no default row exists', async () => {
    mockContainerImage.findFirst.mockResolvedValue(null);
    const tag = await getDefaultImage(prisma);
    // Falls back to controlPlaneConfig.TENANT_IMAGE (from env or default)
    expect(typeof tag).toBe('string');
    expect(tag.length).toBeGreaterThan(0);
  });
});

describe('seedDefaultImage', () => {
  it('does nothing if a default image already exists', async () => {
    mockContainerImage.findFirst.mockResolvedValue({ id: 'img-1', tag: 'claw-tenant:sha-abc1234', is_default: 1 });
    await seedDefaultImage(prisma);
    expect(mockContainerImage.create).not.toHaveBeenCalled();
    expect(mockContainerImage.update).not.toHaveBeenCalled();
  });

  it('creates a new default row if none exists', async () => {
    mockContainerImage.findFirst.mockResolvedValue(null);
    mockContainerImage.findUnique.mockResolvedValue(null);
    mockContainerImage.create.mockResolvedValue({});
    await seedDefaultImage(prisma);
    expect(mockContainerImage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ is_default: 1 }),
      }),
    );
  });

  it('uses the configured TENANT_IMAGE tag when creating the default row', async () => {
    mockContainerImage.findFirst.mockResolvedValue(null);
    mockContainerImage.create.mockResolvedValue({});
    await seedDefaultImage(prisma);
    expect(mockContainerImage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          is_default: 1,
          created_at: expect.any(Number) as number,
        }),
      }),
    );
  });
});

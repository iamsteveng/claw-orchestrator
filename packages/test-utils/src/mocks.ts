import { vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

/**
 * Returns a vitest mock of the Prisma Client with all commonly-used model methods mocked.
 * Returned mocks resolve to undefined by default; override with .mockResolvedValue() per test.
 */
export function mockPrismaClient(): ReturnType<typeof createMockPrisma> {
  return createMockPrisma();
}

function mockModel() {
  return {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
    upsert: vi.fn(),
  };
}

function createMockPrisma() {
  return {
    tenant: mockModel(),
    messageQueue: mockModel(),
    startupLock: mockModel(),
    auditLog: mockModel(),
    allowlist: mockModel(),
    containerImage: mockModel(),
    $transaction: vi.fn((arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      if (typeof arg === 'function') return arg({ tenant: mockModel() });
      return Promise.resolve();
    }),
    $connect: vi.fn(),
    $disconnect: vi.fn(),
  } as unknown as PrismaClient & ReturnType<typeof createMockPrismaShape>;
}

function createMockPrismaShape() {
  return {
    tenant: mockModel(),
    messageQueue: mockModel(),
    startupLock: mockModel(),
    auditLog: mockModel(),
    allowlist: mockModel(),
    containerImage: mockModel(),
  };
}

/**
 * Returns a vitest mock of the docker-client DockerClient object.
 * Uses plain vi.fn() mocks for each method.
 */
export function mockDockerClient() {
  return {
    run: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    rm: vi.fn(),
    inspect: vi.fn(),
    exec: vi.fn(),
  };
}

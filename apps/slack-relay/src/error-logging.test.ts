/**
 * US-002: Tests for error logging in relay message forwarding flow
 * - Step 4: Prisma enqueue errors are logged
 * - Step 5: CP message endpoint non-2xx responses are logged as errors
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processSlackEventWithConfig, type SlackEventEnvelope } from './app-factory.js';
import type { SlackRelayConfig } from '@claw/shared-config/slack-relay';

const makeConfig = (): SlackRelayConfig => ({
  SLACK_RELAY_PORT: 3100,
  SLACK_SIGNING_SECRET: 'test-secret',
  SLACK_BOT_TOKEN: 'xoxb-test-token',
  CONTROL_PLANE_URL: 'http://localhost:9999',
});

const makeEnvelope = (overrides: Partial<SlackEventEnvelope> = {}): SlackEventEnvelope => ({
  type: 'event_callback',
  team_id: 'T_TEST',
  event_id: 'Ev_TEST_001',
  event: {
    user: 'U_TEST',
    type: 'message',
    text: 'hello',
    channel: 'C_TEST',
  },
  ...overrides,
});

const makeLog = () => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
});

/** Build a mock fetch that returns provision OK, then ACTIVE poll, then the supplied message response */
const makeFetchWithMessageResponse = (messageResponse: { status: number; body: object }) => {
  let callCount = 0;
  return vi.fn().mockImplementation(async (url: string) => {
    callCount++;
    // provision call → return ACTIVE immediately
    if (url.includes('/v1/tenants/provision')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ tenantId: 'tenant123', status: 'ACTIVE', relayToken: 'relay-tok' }),
      };
    }
    // message forwarding call
    if (url.includes('/v1/tenants/tenant123/message')) {
      return {
        ok: messageResponse.status >= 200 && messageResponse.status < 300,
        status: messageResponse.status,
        json: async () => messageResponse.body,
      };
    }
    // fallback
    return { ok: true, status: 200, json: async () => ({}) };
  });
};

describe('US-002: Error logging in relay message forwarding', () => {
  describe('Step 4 - Prisma enqueue errors', () => {
    it('logs error when Prisma enqueue throws and no existing row found', async () => {
      const log = makeLog();
      const fetchFn = makeFetchWithMessageResponse({ status: 200, body: { ok: true } });

      const mockPrisma = {
        messageQueue: {
          create: vi.fn().mockRejectedValue(new Error('DB connection lost')),
          findUnique: vi.fn().mockResolvedValue(null), // no existing row → real error
          update: vi.fn().mockResolvedValue({}),
        },
      };

      await processSlackEventWithConfig(
        makeEnvelope(),
        makeConfig(),
        log,
        fetchFn as unknown as typeof fetch,
        mockPrisma as unknown as import('@prisma/client').PrismaClient,
      );

      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant123', slackEventId: 'Ev_TEST_001' }),
        expect.stringContaining('Failed to enqueue message in Prisma'),
      );
    });

    it('does NOT log error when Prisma create fails but existing row is found (idempotency)', async () => {
      const log = makeLog();
      const fetchFn = makeFetchWithMessageResponse({ status: 200, body: { ok: true } });

      const mockPrisma = {
        messageQueue: {
          create: vi.fn().mockRejectedValue(new Error('Unique constraint failed')),
          findUnique: vi.fn().mockResolvedValue({ id: 'existing-id', status: 'DELIVERED' }),
          update: vi.fn().mockResolvedValue({}),
        },
      };

      await processSlackEventWithConfig(
        makeEnvelope(),
        makeConfig(),
        log,
        fetchFn as unknown as typeof fetch,
        mockPrisma as unknown as import('@prisma/client').PrismaClient,
      );

      // Should NOT log error for idempotent duplicate
      const prismaErrors = log.error.mock.calls.filter((call) =>
        String(call[1]).includes('Failed to enqueue'),
      );
      expect(prismaErrors).toHaveLength(0);
    });
  });

  describe('Step 5 - CP message endpoint errors', () => {
    it('logs error when CP message endpoint returns 500', async () => {
      const log = makeLog();
      const fetchFn = makeFetchWithMessageResponse({
        status: 500,
        body: { error: 'internal server error' },
      });

      await processSlackEventWithConfig(
        makeEnvelope(),
        makeConfig(),
        log,
        fetchFn as unknown as typeof fetch,
      );

      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant123',
          slackEventId: 'Ev_TEST_001',
          status: 500,
        }),
        expect.stringContaining('CP message endpoint returned non-2xx'),
      );
    });

    it('logs error when CP message endpoint returns 503', async () => {
      const log = makeLog();
      const fetchFn = makeFetchWithMessageResponse({
        status: 503,
        body: { error: 'service unavailable' },
      });

      await processSlackEventWithConfig(
        makeEnvelope(),
        makeConfig(),
        log,
        fetchFn as unknown as typeof fetch,
      );

      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ status: 503 }),
        expect.stringContaining('CP message endpoint returned non-2xx'),
      );
    });

    it('does not log non-2xx error when CP returns 200', async () => {
      const log = makeLog();
      const fetchFn = makeFetchWithMessageResponse({
        status: 200,
        body: { ok: true, response: 'Hello!' },
      });

      // need to mock the chat.postMessage call too
      const fullFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/v1/tenants/provision')) {
          return { ok: true, status: 200, json: async () => ({ tenantId: 'tenant123', status: 'ACTIVE', relayToken: 'relay-tok' }) };
        }
        if (url.includes('/v1/tenants/tenant123/message')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, response: 'Hello!' }) };
        }
        if (url.includes('chat.postMessage')) {
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      });

      await processSlackEventWithConfig(
        makeEnvelope(),
        makeConfig(),
        log,
        fullFetch as unknown as typeof fetch,
      );

      const non2xxErrors = log.error.mock.calls.filter((call) =>
        String(call[1]).includes('non-2xx'),
      );
      expect(non2xxErrors).toHaveLength(0);
    });
  });
});

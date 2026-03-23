import { describe, it, expect, vi } from 'vitest';
import { postSlackDm } from './app-factory.js';

describe('postSlackDm', () => {
  it('logs error when conversations.open fails', async () => {
    const mockLog = { error: vi.fn() };
    const mockFetch = vi.fn().mockResolvedValueOnce({
      json: async () => ({ ok: false, error: 'channel_not_found' }),
    });

    await postSlackDm('U123', 'hello', 'xoxb-token', mockFetch as unknown as typeof fetch, mockLog);

    expect(mockLog.error).toHaveBeenCalledOnce();
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'U123', slackError: 'channel_not_found' }),
      expect.stringContaining('conversations.open failed'),
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('logs error when conversations.open returns ok but no channel id', async () => {
    const mockLog = { error: vi.fn() };
    const mockFetch = vi.fn().mockResolvedValueOnce({
      json: async () => ({ ok: true, channel: undefined }),
    });

    await postSlackDm('U123', 'hello', 'xoxb-token', mockFetch as unknown as typeof fetch, mockLog);

    expect(mockLog.error).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('logs error when chat.postMessage fails', async () => {
    const mockLog = { error: vi.fn() };
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        json: async () => ({ ok: true, channel: { id: 'D_CHAN' } }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ ok: false, error: 'not_in_channel' }),
      });

    await postSlackDm('U123', 'hello', 'xoxb-token', mockFetch as unknown as typeof fetch, mockLog);

    expect(mockLog.error).toHaveBeenCalledOnce();
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'U123', slackError: 'not_in_channel' }),
      expect.stringContaining('chat.postMessage failed'),
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not log error on success', async () => {
    const mockLog = { error: vi.fn() };
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        json: async () => ({ ok: true, channel: { id: 'D_CHAN' } }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ ok: true }),
      });

    await postSlackDm('U123', 'hello', 'xoxb-token', mockFetch as unknown as typeof fetch, mockLog);

    expect(mockLog.error).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('works without a logger (no crash when log is undefined)', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      json: async () => ({ ok: false, error: 'some_error' }),
    });

    await expect(
      postSlackDm('U123', 'hello', 'xoxb-token', mockFetch as unknown as typeof fetch),
    ).resolves.toBeUndefined();
  });
});

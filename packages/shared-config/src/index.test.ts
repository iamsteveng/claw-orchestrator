import { describe, it, expect, afterEach, vi } from 'vitest';

describe('slackRelayConfig validation', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('throws ZodError when SLACK_SIGNING_SECRET is missing', async () => {
    const savedEnv = { ...process.env };
    delete process.env.SLACK_SIGNING_SECRET;
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.CONTROL_PLANE_URL = 'http://localhost:3200';

    await expect(import('./slack-relay.js')).rejects.toThrow();

    process.env = savedEnv;
  });

  it('throws ZodError when SLACK_BOT_TOKEN is missing', async () => {
    const savedEnv = { ...process.env };
    process.env.SLACK_SIGNING_SECRET = 'test-secret';
    delete process.env.SLACK_BOT_TOKEN;
    process.env.CONTROL_PLANE_URL = 'http://localhost:3200';

    await expect(import('./slack-relay.js')).rejects.toThrow();

    process.env = savedEnv;
  });
});

describe('controlPlaneConfig validation', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('applies defaults for optional fields', async () => {
    const savedEnv = { ...process.env };
    process.env.DATABASE_URL = 'file:/tmp/test.db';
    process.env.DATA_DIR = '/data/tenants';
    process.env.TENANT_IMAGE = 'claw-tenant:latest';
    delete process.env.CONTROL_PLANE_PORT;
    delete process.env.LOG_LEVEL;
    delete process.env.MAX_ACTIVE_TENANTS;
    delete process.env.ACTIVE_TENANTS_OVERFLOW_POLICY;

    const { controlPlaneConfig } = await import('./control-plane.js');
    expect(controlPlaneConfig.CONTROL_PLANE_PORT).toBe(3200);
    expect(controlPlaneConfig.LOG_LEVEL).toBe('info');
    expect(controlPlaneConfig.MAX_ACTIVE_TENANTS).toBe(10);
    expect(controlPlaneConfig.ACTIVE_TENANTS_OVERFLOW_POLICY).toBe('queue');

    process.env = savedEnv;
  });
});

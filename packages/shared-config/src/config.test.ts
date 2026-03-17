import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { controlPlaneConfigSchema } from './schemas.js';
import { slackRelayConfigSchema } from './schemas.js';
import { schedulerConfigSchema } from './schemas.js';

describe('controlPlaneConfigSchema', () => {
  it('uses defaults when optional vars are absent', () => {
    const config = controlPlaneConfigSchema.parse({
      DATABASE_URL: 'file:/tmp/test.db',
      DATA_DIR: '/data/tenants',
      TENANT_IMAGE: 'claw-tenant:latest',
    });
    expect(config.CONTROL_PLANE_PORT).toBe(3200);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.MAX_ACTIVE_TENANTS).toBe(10);
    expect(config.ACTIVE_TENANTS_OVERFLOW_POLICY).toBe('queue');
  });

  it('accepts valid override values', () => {
    const config = controlPlaneConfigSchema.parse({
      DATABASE_URL: 'file:/tmp/test.db',
      DATA_DIR: '/data/tenants',
      TENANT_IMAGE: 'claw-tenant:latest',
      CONTROL_PLANE_PORT: '4000',
      MAX_ACTIVE_TENANTS: '20',
      ACTIVE_TENANTS_OVERFLOW_POLICY: 'reject',
    });
    expect(config.CONTROL_PLANE_PORT).toBe(4000);
    expect(config.MAX_ACTIVE_TENANTS).toBe(20);
    expect(config.ACTIVE_TENANTS_OVERFLOW_POLICY).toBe('reject');
  });

  it('throws ZodError when required vars are missing', () => {
    expect(() => controlPlaneConfigSchema.parse({})).toThrow(ZodError);
  });
});

describe('slackRelayConfigSchema', () => {
  it('throws ZodError when SLACK_SIGNING_SECRET is missing', () => {
    expect(() =>
      slackRelayConfigSchema.parse({
        SLACK_BOT_TOKEN: 'xoxb-test',
        CONTROL_PLANE_URL: 'http://localhost:3200',
      })
    ).toThrow(ZodError);
  });

  it('throws ZodError when SLACK_BOT_TOKEN is missing', () => {
    expect(() =>
      slackRelayConfigSchema.parse({
        SLACK_SIGNING_SECRET: 'secret',
        CONTROL_PLANE_URL: 'http://localhost:3200',
      })
    ).toThrow(ZodError);
  });

  it('uses default port when SLACK_RELAY_PORT is absent', () => {
    const config = slackRelayConfigSchema.parse({
      SLACK_SIGNING_SECRET: 'secret',
      SLACK_BOT_TOKEN: 'xoxb-test',
      CONTROL_PLANE_URL: 'http://localhost:3200',
    });
    expect(config.SLACK_RELAY_PORT).toBe(3000);
  });

  it('accepts valid config', () => {
    const config = slackRelayConfigSchema.parse({
      SLACK_RELAY_PORT: '4000',
      SLACK_SIGNING_SECRET: 'my-secret',
      SLACK_BOT_TOKEN: 'xoxb-token',
      CONTROL_PLANE_URL: 'http://localhost:3200',
    });
    expect(config.SLACK_RELAY_PORT).toBe(4000);
    expect(config.SLACK_SIGNING_SECRET).toBe('my-secret');
  });
});

describe('schedulerConfigSchema', () => {
  const required = {
    DATABASE_URL: 'file:/tmp/scheduler.db',
    CONTROL_PLANE_URL: 'http://localhost:3200',
    SLACK_BOT_TOKEN: 'xoxb-test-token',
  };

  it('uses defaults when optional vars are absent', () => {
    const config = schedulerConfigSchema.parse(required);
    expect(config.SCHEDULER_INTERVAL_MS).toBe(60000);
    expect(config.IDLE_STOP_HOURS).toBe(48);
  });

  it('accepts overrides', () => {
    const config = schedulerConfigSchema.parse({
      ...required,
      SCHEDULER_INTERVAL_MS: '30000',
      IDLE_STOP_HOURS: '24',
    });
    expect(config.SCHEDULER_INTERVAL_MS).toBe(30000);
    expect(config.IDLE_STOP_HOURS).toBe(24);
  });

  it('throws ZodError when DATABASE_URL is missing', () => {
    expect(() => schedulerConfigSchema.parse({ CONTROL_PLANE_URL: 'http://localhost:3200' })).toThrow(ZodError);
  });
});

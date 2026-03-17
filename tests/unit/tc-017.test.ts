/**
 * TC-017: Config validation → missing env var causes fast failure
 *
 * Verifies that each service's Zod config schema throws ZodError when a
 * required environment variable is absent from process.env.
 *
 * The config modules (slack-relay.ts, control-plane.ts) each do:
 *   export const config = schema.parse(process.env)
 * at module load time. If the schema throws, the module fails immediately.
 * Testing the schema directly with process.env as input is the canonical
 * approach (see packages/shared-config/src/config.test.ts).
 *
 * Note: vi.resetModules() + dynamic import does NOT work in this codebase
 * because Vite's resolver fails to load 'zod' after module cache is cleared.
 * Note: 'zod' is not a workspace-root dependency, so ZodError cannot be
 * imported directly. We check err.name === 'ZodError' and err.issues instead.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { slackRelayConfigSchema, controlPlaneConfigSchema } from '../../packages/shared-config/src/schemas.js';

describe('TC-017: Config validation → missing env var causes fast failure', () => {
  // Save originals to restore after each test
  let savedSlackSecret: string | undefined;
  let savedDatabaseUrl: string | undefined;

  afterEach(() => {
    if (savedSlackSecret === undefined) {
      delete process.env.SLACK_SIGNING_SECRET;
    } else {
      process.env.SLACK_SIGNING_SECRET = savedSlackSecret;
    }
    if (savedDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = savedDatabaseUrl;
    }
  });

  it('TC-017: missing SLACK_SIGNING_SECRET → slack-relay config throws ZodError', () => {
    savedSlackSecret = process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_SIGNING_SECRET;

    let error: unknown;
    expect(() => {
      try {
        slackRelayConfigSchema.parse(process.env);
      } catch (e) {
        error = e;
        throw e;
      }
    }).toThrow();

    expect((error as Error).name).toBe('ZodError');
    const issues = (error as { issues: Array<{ path: unknown[] }> }).issues;
    const fields = issues.map((i) => i.path[0]);
    expect(fields).toContain('SLACK_SIGNING_SECRET');
  });

  it('TC-017: missing DATABASE_URL → control-plane config throws ZodError', () => {
    savedDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    let error: unknown;
    expect(() => {
      try {
        controlPlaneConfigSchema.parse(process.env);
      } catch (e) {
        error = e;
        throw e;
      }
    }).toThrow();

    expect((error as Error).name).toBe('ZodError');
    const issues = (error as { issues: Array<{ path: unknown[] }> }).issues;
    const fields = issues.map((i) => i.path[0]);
    expect(fields).toContain('DATABASE_URL');
  });

  it('TC-017: ZodError message identifies the missing field name', () => {
    savedSlackSecret = process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_SIGNING_SECRET;

    let caughtError: unknown;
    try {
      slackRelayConfigSchema.parse(process.env);
    } catch (e) {
      caughtError = e;
    }

    expect((caughtError as Error).name).toBe('ZodError');
    const zodErr = caughtError as { message: string; issues: Array<{ path: unknown[] }> };
    // The error message or issues must mention the missing field
    const mentionsField = zodErr.message.includes('SLACK_SIGNING_SECRET') ||
      zodErr.issues.some(issue => issue.path.includes('SLACK_SIGNING_SECRET'));
    expect(mentionsField).toBe(true);
  });
});

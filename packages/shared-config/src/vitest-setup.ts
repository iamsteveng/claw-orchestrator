// Provide minimum required env vars so config modules can be imported in tests.
// Tests that verify missing-var behavior use vi.resetModules() + dynamic imports.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:/tmp/test.db';
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/claw-test-tenants';
process.env.TENANT_IMAGE = process.env.TENANT_IMAGE || 'claw-tenant:test';
process.env.SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || 'test-signing-secret';
process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'xoxb-test-token';
process.env.CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL || 'http://localhost:3200';
process.env.DATA_MOUNT = process.env.DATA_MOUNT || '/data';
// TEMPLATES_DIR default points to a non-existent path in test environments.
// Override with a path that exists in the repo (used by integration tests).
process.env.TEMPLATES_DIR = process.env.TEMPLATES_DIR || `${process.cwd()}/templates/workspace`;

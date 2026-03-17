// Provide minimum required env vars so config modules can be imported in tests.
// Tests that verify missing-var behavior use vi.resetModules() + dynamic imports.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:/tmp/test.db';
process.env.DATA_DIR = process.env.DATA_DIR || '/data/tenants';
process.env.TENANT_IMAGE = process.env.TENANT_IMAGE || 'claw-tenant:test';
process.env.SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || 'test-signing-secret';
process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'xoxb-test-token';
process.env.CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL || 'http://localhost:3200';
process.env.DATA_MOUNT = process.env.DATA_MOUNT || '/data';

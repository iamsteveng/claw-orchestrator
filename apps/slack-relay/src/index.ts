import Fastify from 'fastify';
import { slackRelayConfig } from '@claw/shared-config/slack-relay';

const startedAt = Date.now();

const app = Fastify({
  logger: {
    level: 'info',
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty' }
      : undefined,
    base: { service: 'slack-relay' },
  },
  genReqId: () => crypto.randomUUID(),
});

// ─── Health route ─────────────────────────────────────────────────────────────

app.get('/health', async (_req, reply) => {
  return reply.send({ ok: true, uptime: Date.now() - startedAt });
});

// ─── Startup sweep ────────────────────────────────────────────────────────────

async function startupSweep(): Promise<void> {
  // Reset any PROCESSING message_queue rows older than 2 minutes.
  // The control plane handles this internally; for the relay, we log a note.
  app.log.info({ service: 'slack-relay' }, 'Startup sweep: PROCESSING messages reset by control plane on its startup');
}

// ─── Server startup ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await startupSweep();

  await app.listen({
    port: slackRelayConfig.SLACK_RELAY_PORT,
    host: '0.0.0.0',
  });

  app.log.info(
    { service: 'slack-relay', port: slackRelayConfig.SLACK_RELAY_PORT },
    'Slack relay started',
  );
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  app.log.info({ service: 'slack-relay' }, 'Shutting down...');
  await app.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

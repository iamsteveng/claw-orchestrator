import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

const MAX_TIMESTAMP_AGE_SECONDS = 5 * 60; // 5 minutes

/**
 * Verifies the Slack request signature.
 *
 * Algorithm:
 *   1. Check X-Slack-Request-Timestamp is within 5 minutes.
 *   2. Compute HMAC-SHA256 of 'v0:<timestamp>:<rawBody>' using SLACK_SIGNING_SECRET.
 *   3. Compare with X-Slack-Signature header using timingSafeEqual (constant-time).
 */
export function verifySlackSignature(
  rawBody: string,
  headers: { 'x-slack-signature'?: string; 'x-slack-request-timestamp'?: string },
  signingSecret: string,
): boolean {
  const timestamp = headers['x-slack-request-timestamp'];
  const signature = headers['x-slack-signature'];

  if (!timestamp || !signature) {
    return false;
  }

  const ts = Number(timestamp);
  if (isNaN(ts)) {
    return false;
  }

  // Replay attack prevention
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_TIMESTAMP_AGE_SECONDS) {
    return false;
  }

  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = createHmac('sha256', signingSecret);
  hmac.update(baseString);
  const computed = `v0=${hmac.digest('hex')}`;

  // Compare using timingSafeEqual (constant-time comparison)
  const computedBuf = Buffer.from(computed, 'utf8');
  const sigBuf = Buffer.from(signature, 'utf8');

  if (computedBuf.length !== sigBuf.length) {
    return false;
  }

  return timingSafeEqual(computedBuf, sigBuf);
}

/**
 * Fastify preHandler hook for POST /slack/events.
 * Expects rawBody to be attached to req as (req as RequestWithRawBody).rawBody.
 */
export interface RequestWithRawBody extends FastifyRequest {
  rawBody?: string;
}

export async function slackSignatureHook(
  req: RequestWithRawBody,
  reply: FastifyReply,
  signingSecret: string,
): Promise<void> {
  const valid = verifySlackSignature(
    req.rawBody ?? '',
    {
      'x-slack-signature': req.headers['x-slack-signature'] as string | undefined,
      'x-slack-request-timestamp': req.headers['x-slack-request-timestamp'] as string | undefined,
    },
    signingSecret,
  );

  if (!valid) {
    return reply.status(403).send({ error: 'Invalid signature' });
  }
}

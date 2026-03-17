import type { PrismaClient } from '@prisma/client';

/**
 * Returns true if the given Slack user is allowed to access the system.
 *
 * Queries allowlist WHERE revoked_at IS NULL AND slack_team_id=? AND
 * (slack_user_id=? OR slack_user_id IS NULL)
 *
 * A null slack_user_id allows the entire team.
 */
export async function isAllowed(
  prisma: PrismaClient,
  slackTeamId: string,
  slackUserId: string,
): Promise<boolean> {
  const entry = await prisma.allowlist.findFirst({
    where: {
      slack_team_id: slackTeamId,
      revoked_at: null,
      OR: [
        { slack_user_id: slackUserId },
        { slack_user_id: null },
      ],
    },
  });
  return entry !== null;
}

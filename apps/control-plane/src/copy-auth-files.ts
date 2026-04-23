import { mkdir, copyFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

/**
 * Copies auth credential files from the host into the tenant's home directory.
 * Best-effort: logs a warning if a file is missing but does not throw.
 *
 * HOME resolution: process.env.HOME (from systemd env file or compose env)
 * falls back to os.homedir() (reads /etc/passwd for the effective UID).
 */
export async function copyAuthFiles(
  dataDir: string,
  log: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<void> {
  const hostHome = process.env.HOME ?? homedir();
  const authSrc = `${hostHome}/.openclaw/agents/main/agent/auth-profiles.json`;
  const credsSrc = `${hostHome}/.claude/.credentials.json`;
  const authDest = `${dataDir}/home/.openclaw/agents/main/agent/auth-profiles.json`;
  const credsDest = `${dataDir}/home/.claude/.credentials.json`;

  log.info(`copyAuthFiles: resolved HOME=${hostHome}, authSrc=${authSrc}, credsSrc=${credsSrc}`);

  const pairs: [string, string][] = [
    [authSrc, authDest],
    [credsSrc, credsDest],
  ];

  for (const [src, dest] of pairs) {
    try {
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(src, dest);
      await chmod(dest, 0o644);
    } catch {
      log.warn(`copyAuthFiles: could not copy ${src} → ${dest} — tenant model calls may fail`);
    }
  }
}

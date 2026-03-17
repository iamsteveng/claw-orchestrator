import { readdir, readFile, writeFile, copyFile, appendFile, access } from 'node:fs/promises';
import { join } from 'node:path';

const TASK_EXECUTION_SECTION = '## Task Execution';

/**
 * Copies all files from templatesDir into workspacePath.
 * Special merge logic for AGENTS.md:
 *   1. If AGENTS.md does not exist in workspace → copy directly from template.
 *   2. If AGENTS.md exists and already contains '## Task Execution' → leave untouched.
 *   3. If AGENTS.md exists but is missing '## Task Execution' → append the section verbatim.
 */
export async function seedWorkspace(workspacePath: string, templatesDir: string): Promise<void> {
  const entries = await readdir(templatesDir);

  for (const entry of entries) {
    const srcPath = join(templatesDir, entry);
    const dstPath = join(workspacePath, entry);

    if (entry === 'AGENTS.md') {
      await mergeAgentsMd(srcPath, dstPath);
    } else {
      await copyFile(srcPath, dstPath);
    }
  }
}

async function mergeAgentsMd(srcPath: string, dstPath: string): Promise<void> {
  // Check if AGENTS.md exists in workspace
  const exists = await fileExists(dstPath);

  if (!exists) {
    // Scenario 1: file does not exist → copy directly
    await copyFile(srcPath, dstPath);
    return;
  }

  const existing = await readFile(dstPath, 'utf8');

  if (existing.includes(TASK_EXECUTION_SECTION)) {
    // Scenario 2: already contains the section → leave untouched
    return;
  }

  // Scenario 3: exists but missing section → append verbatim from template
  const template = await readFile(srcPath, 'utf8');

  // Find the Task Execution section content from template
  const sectionIdx = template.indexOf(TASK_EXECUTION_SECTION);
  const sectionContent = template.slice(sectionIdx);

  // Append with a newline separator
  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  await appendFile(dstPath, separator + sectionContent);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * TC-012: AGENTS.md pre-seeded correctly in tenant workspace
 *
 * Verifies that seedWorkspace handles three merge scenarios:
 *  1. AGENTS.md does not exist → copy from template (contains '## Task Execution')
 *  2. AGENTS.md already has '## Task Execution' → leave untouched
 *  3. AGENTS.md exists but missing '## Task Execution' → append the section
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { seedWorkspace } from '../../apps/control-plane/src/seed-workspace.js';

const TEMPLATES_DIR = join(
  new URL('../../templates/workspace', import.meta.url).pathname
);

describe('TC-012: AGENTS.md pre-seeded correctly in tenant workspace', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'claw-tc012-'));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('TC-012: scenario 1 — AGENTS.md created with ## Task Execution when missing', async () => {
    await seedWorkspace(workspaceDir, TEMPLATES_DIR);

    const content = await readFile(join(workspaceDir, 'AGENTS.md'), 'utf8');
    expect(content).toContain('## Task Execution');
  });

  it('TC-012: scenario 2 — AGENTS.md left untouched when ## Task Execution already present', async () => {
    const original = `# My Agents\n\n## Task Execution\n\nCustom instructions.\n`;
    await writeFile(join(workspaceDir, 'AGENTS.md'), original, 'utf8');

    await seedWorkspace(workspaceDir, TEMPLATES_DIR);

    const content = await readFile(join(workspaceDir, 'AGENTS.md'), 'utf8');
    expect(content).toBe(original);
  });

  it('TC-012: scenario 3 — ## Task Execution appended when AGENTS.md exists but lacks it', async () => {
    const original = `# My Agents\n\nSome existing content.\n`;
    await writeFile(join(workspaceDir, 'AGENTS.md'), original, 'utf8');

    await seedWorkspace(workspaceDir, TEMPLATES_DIR);

    const content = await readFile(join(workspaceDir, 'AGENTS.md'), 'utf8');
    expect(content).toContain('Some existing content.');
    expect(content).toContain('## Task Execution');
    expect(content.indexOf('Some existing content.')).toBeLessThan(
      content.indexOf('## Task Execution')
    );
  });
});

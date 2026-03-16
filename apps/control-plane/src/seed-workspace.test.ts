import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { seedWorkspace } from './seed-workspace.js';

const TEMPLATE_AGENTS_MD = `## Task Execution

For any task that is complex enough to take more than ~2 minutes:
- Spawn a sub-agent or background process to handle it
- Don't block the conversation
- When it's done, report back with a concise summary of what was done
`;

describe('seedWorkspace', () => {
  let templatesDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    templatesDir = await mkdtemp(join(tmpdir(), 'claw-templates-'));
    workspaceDir = await mkdtemp(join(tmpdir(), 'claw-workspace-'));

    // Write template AGENTS.md
    await writeFile(join(templatesDir, 'AGENTS.md'), TEMPLATE_AGENTS_MD, 'utf8');
  });

  afterEach(async () => {
    await rm(templatesDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('copies AGENTS.md directly when it does not exist in workspace', async () => {
    await seedWorkspace(workspaceDir, templatesDir);

    const result = await readFile(join(workspaceDir, 'AGENTS.md'), 'utf8');
    expect(result).toBe(TEMPLATE_AGENTS_MD);
  });

  it('leaves AGENTS.md untouched when it already contains ## Task Execution', async () => {
    const existingContent = `# My Custom Agents\n\n## Task Execution\n\nCustom instructions here.\n`;
    await writeFile(join(workspaceDir, 'AGENTS.md'), existingContent, 'utf8');

    await seedWorkspace(workspaceDir, templatesDir);

    const result = await readFile(join(workspaceDir, 'AGENTS.md'), 'utf8');
    expect(result).toBe(existingContent);
  });

  it('appends ## Task Execution section when AGENTS.md exists but is missing it', async () => {
    const existingContent = `# My Custom Agents\n\nSome custom content.\n`;
    await writeFile(join(workspaceDir, 'AGENTS.md'), existingContent, 'utf8');

    await seedWorkspace(workspaceDir, templatesDir);

    const result = await readFile(join(workspaceDir, 'AGENTS.md'), 'utf8');
    expect(result).toContain('## Task Execution');
    expect(result).toContain('Some custom content.');
    expect(result.indexOf('Some custom content.')).toBeLessThan(result.indexOf('## Task Execution'));
  });

  it('copies other template files directly', async () => {
    await writeFile(join(templatesDir, 'README.md'), '# Workspace\n', 'utf8');

    await seedWorkspace(workspaceDir, templatesDir);

    const result = await readFile(join(workspaceDir, 'README.md'), 'utf8');
    expect(result).toBe('# Workspace\n');
  });
});

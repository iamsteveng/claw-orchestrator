import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'fs';
import { resolve } from 'path';

const SKILLS_DIR = resolve(__dirname, '../../docker/tenant-image/skills');
const DOCKERFILE_PATH = resolve(__dirname, '../../docker/tenant-image/Dockerfile');
const UPDATE_SCRIPT_PATH = resolve(__dirname, '../../scripts/update-ralph-skills.sh');

const EXPECTED_SKILLS = [
  'prd',
  'ralph',
  'ralph-codex-loop',
  'qa-plan-generator',
  'qa-plan-json',
  'qa-codex-loop',
];

describe('TC-042 Ralph skills baked into tenant Docker image', () => {
  it('TC-042: skills directory contains all 6 ralph skills', () => {
    for (const skill of EXPECTED_SKILLS) {
      const skillPath = resolve(SKILLS_DIR, skill);
      expect(existsSync(skillPath), `skill directory missing: ${skill}`).toBe(true);
      const stat = statSync(skillPath);
      expect(stat.isDirectory(), `skill is not a directory: ${skill}`).toBe(true);
    }
  });

  it('TC-042: each skill directory contains a SKILL.md file', () => {
    for (const skill of EXPECTED_SKILLS) {
      const skillMd = resolve(SKILLS_DIR, skill, 'SKILL.md');
      expect(existsSync(skillMd), `SKILL.md missing in skill: ${skill}`).toBe(true);
    }
  });

  it('TC-042: Dockerfile contains COPY skills/ step targeting openclaw skills dir', () => {
    const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf-8');
    expect(dockerfile).toContain(
      'COPY skills/ /usr/local/lib/node_modules/openclaw/skills/',
    );
  });

  it('TC-042: Dockerfile installs openclaw globally via npm install -g', () => {
    const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf-8');
    expect(dockerfile).toContain('npm install -g');
    expect(dockerfile).toContain('openclaw');
  });

  it('TC-042: update-ralph-skills.sh exists and is executable', () => {
    expect(existsSync(UPDATE_SCRIPT_PATH), 'update-ralph-skills.sh not found').toBe(true);
    const stat = statSync(UPDATE_SCRIPT_PATH);
    // Check executable bit (owner or group or other)
    const isExecutable = (stat.mode & 0o111) !== 0;
    expect(isExecutable, 'update-ralph-skills.sh is not executable').toBe(true);
  });

  it('TC-042: update-ralph-skills.sh references all 6 skills', () => {
    const script = readFileSync(UPDATE_SCRIPT_PATH, 'utf-8');
    for (const skill of EXPECTED_SKILLS) {
      expect(script, `skill missing from update script: ${skill}`).toContain(skill);
    }
  });
});

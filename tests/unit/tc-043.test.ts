import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(__dirname, '../..');
const SYSTEMD_DIR = join(REPO_ROOT, 'deploy/systemd');
const RUNTIME_ENV_HELPER = join(REPO_ROOT, 'deploy/scripts/runtime-env.sh');
const INSTALL_SERVICES_SCRIPT = join(REPO_ROOT, 'deploy/scripts/install-services.sh');
const BACKUP_SCRIPT = join(REPO_ROOT, 'deploy/scripts/backup.sh');
const ENV_EXAMPLE = join(REPO_ROOT, '.env.example');
const LEGACY_HARDCODED_PATH = '/home/ubuntu/.openclaw/workspace/claw-orchestrator';

describe('TC-043 deployment assets are relocatable and env syncing is template-driven', () => {
  it('checked-in systemd assets use __REPO_DIR__ placeholders instead of the old hardcoded checkout path', () => {
    const files = [
      'claw-control-plane.service',
      'claw-slack-relay.service',
      'claw-scheduler.service',
      'claw-backup.service',
      'claw-orchestrator.env',
    ];

    for (const file of files) {
      const content = readFileSync(join(SYSTEMD_DIR, file), 'utf-8');
      expect(content).toContain('__REPO_DIR__');
      expect(content).not.toContain(LEGACY_HARDCODED_PATH);
    }
  });

  it('install-services.sh renders backup service units and enables the backup timer', () => {
    const content = readFileSync(INSTALL_SERVICES_SCRIPT, 'utf-8');
    expect(content).toContain('render_systemd_unit_file');
    expect(content).toContain('claw-backup.service');
    expect(content).toContain('claw-backup.timer');
    expect(content).toContain('enable --now claw-backup.timer');
  });

  it('backup.sh derives database and tenant paths from env-aware runtime config', () => {
    const content = readFileSync(BACKUP_SCRIPT, 'utf-8');
    expect(content).toContain('DATABASE_URL');
    expect(content).toContain('DATA_DIR');
    expect(content).toContain('"${DATA_DIR}/"');
  });

  it('runtime-env helper renders __REPO_DIR__ and syncs supported runtime keys from repo .env', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'tc-043-'));
    const templateFile = join(tempRoot, 'template.env');
    const sourceEnvFile = join(tempRoot, 'source.env');
    const outputFile = join(tempRoot, 'rendered.env');

    try {
      writeFileSync(templateFile, [
        'DATA_DIR=/data/tenants',
        'TEMPLATES_DIR=__REPO_DIR__/templates/workspace',
        'S3_BUCKET=',
        'CONTROL_PLANE_URL=http://localhost:3200',
      ].join('\n'));
      writeFileSync(sourceEnvFile, [
        'DATA_DIR=/srv/tenants',
        'S3_BUCKET=claw-backups',
        'CONTROL_PLANE_URL=https://cp.internal',
        'UNRELATED_KEY=do-not-copy',
      ].join('\n'));

      const result = spawnSync('bash', ['-lc', `
        source "${RUNTIME_ENV_HELPER}"
        render_runtime_env_file "${templateFile}" "${sourceEnvFile}" "${outputFile}" "/srv/claw"
      `], { encoding: 'utf-8' });

      expect(result.status).toBe(0);

      const rendered = readFileSync(outputFile, 'utf-8');
      expect(rendered).toContain('DATA_DIR=/srv/tenants');
      expect(rendered).toContain('TEMPLATES_DIR=/srv/claw/templates/workspace');
      expect(rendered).toContain('S3_BUCKET=claw-backups');
      expect(rendered).toContain('CONTROL_PLANE_URL=https://cp.internal');
      expect(rendered).not.toContain('UNRELATED_KEY');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('repo .env.example leaves TEMPLATES_DIR as an optional override instead of a baked-in checkout path', () => {
    const content = readFileSync(ENV_EXAMPLE, 'utf-8');
    expect(content).not.toMatch(/^TEMPLATES_DIR=/m);
    expect(content).toContain('# TEMPLATES_DIR=');
    expect(content).not.toContain(LEGACY_HARDCODED_PATH);
  });
});

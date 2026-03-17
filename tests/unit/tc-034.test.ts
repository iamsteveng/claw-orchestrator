import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const SCRIPT_PATH = join(__dirname, '../../scripts/tenant-shell.sh');

describe('TC-034 tenant-shell script validates container is running', () => {
  it('TC-034 scripts/tenant-shell.sh exists', () => {
    expect(existsSync(SCRIPT_PATH), 'tenant-shell.sh should exist').toBe(true);
  });

  it('TC-034 script has #!/bin/bash shebang', () => {
    const content = readFileSync(SCRIPT_PATH, 'utf-8');
    expect(content.startsWith('#!/bin/bash')).toBe(true);
  });

  it('TC-034 script contains docker exec -it --user agent', () => {
    const content = readFileSync(SCRIPT_PATH, 'utf-8');
    expect(content).toContain('docker exec -it --user agent');
  });

  it('TC-034 script validates containerName argument (exits when empty)', () => {
    const content = readFileSync(SCRIPT_PATH, 'utf-8');
    // Must check for empty TENANT_ID and exit
    expect(content).toContain('exit 1');
    // Must reference TENANT_ID or the first positional argument
    expect(content).toMatch(/TENANT_ID|"\$\{1[:-]/);
  });

  it('TC-034 script validates container is running before exec', () => {
    const content = readFileSync(SCRIPT_PATH, 'utf-8');
    // Must inspect the container status
    expect(content).toContain('docker inspect');
    // Must check for "running" status
    expect(content).toContain('running');
  });
});

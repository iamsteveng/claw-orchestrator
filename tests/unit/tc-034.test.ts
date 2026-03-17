import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const SCRIPT_PATH = join(__dirname, '../../scripts/tenant-shell.sh');

describe('TC-034 tenant-shell script validates container is running', () => {
  it('TC-034 script file exists', () => {
    expect(existsSync(SCRIPT_PATH), 'scripts/tenant-shell.sh should exist').toBe(true);
  });

  it('TC-034 script has correct shebang #!/bin/bash', () => {
    const content = readFileSync(SCRIPT_PATH, 'utf-8');
    expect(content.startsWith('#!/bin/bash')).toBe(true);
  });

  it('TC-034 script contains docker exec -it --user agent', () => {
    const content = readFileSync(SCRIPT_PATH, 'utf-8');
    expect(content).toContain('docker exec -it --user agent');
  });

  it('TC-034 script validates containerName argument and exits if missing', () => {
    const content = readFileSync(SCRIPT_PATH, 'utf-8');
    expect(content).toContain('TENANT_ID');
    expect(content).toMatch(/if \[ -z "?\$\{?TENANT_ID/);
    expect(content).toContain('exit 1');
  });

  it('TC-034 script validates container is running via docker inspect before exec', () => {
    const content = readFileSync(SCRIPT_PATH, 'utf-8');
    expect(content).toContain('docker inspect');
    expect(content).toContain('"running"');
  });
});

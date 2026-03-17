import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const DOCKERFILE_PATH = resolve(__dirname, '../../docker/tenant-image/Dockerfile');

describe('TC-035 Tenant Dockerfile does not embed ANTHROPIC_API_KEY', () => {
  const lines = readFileSync(DOCKERFILE_PATH, 'utf-8').split('\n');

  it('TC-035: no line contains ANTHROPIC_API_KEY', () => {
    const matches = lines.filter(l => l.includes('ANTHROPIC_API_KEY'));
    expect(matches).toEqual([]);
  });

  it('TC-035: no ENV instruction sets any API key', () => {
    const envLines = lines.filter(l => /^\s*ENV\s+/i.test(l));
    const apiKeyEnvLines = envLines.filter(l => /API_KEY/i.test(l));
    expect(apiKeyEnvLines).toEqual([]);
  });

  it('TC-035: auth-profiles.json is not COPYd into the image', () => {
    const copyLines = lines.filter(l => /^\s*COPY\s+/i.test(l));
    const authCopyLines = copyLines.filter(l => l.includes('auth-profiles.json'));
    expect(authCopyLines).toEqual([]);
  });

  it('TC-035: only IMAGE_TAG ARG is present (no auth ARGs)', () => {
    const argLines = lines.filter(l => /^\s*ARG\s+/i.test(l));
    const authArgLines = argLines.filter(l => /API_KEY|TOKEN|SECRET|AUTH/i.test(l));
    expect(authArgLines).toEqual([]);
    const imageTagArg = argLines.find(l => l.includes('IMAGE_TAG'));
    expect(imageTagArg).toBeDefined();
  });
});

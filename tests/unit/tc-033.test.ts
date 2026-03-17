import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const SYSTEMD_DIR = join(__dirname, '../../deploy/systemd');

describe('TC-033 systemd unit files exist for all three services', () => {
  const services = [
    'claw-control-plane.service',
    'claw-slack-relay.service',
    'claw-scheduler.service',
  ];

  for (const service of services) {
    it(`TC-033 ${service} exists and contains WantedBy=multi-user.target`, () => {
      const filePath = join(SYSTEMD_DIR, service);
      expect(existsSync(filePath), `${service} should exist`).toBe(true);
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('WantedBy=multi-user.target');
    });
  }

  it('TC-033 claw-control-plane.service has Requires=docker.service', () => {
    const filePath = join(SYSTEMD_DIR, 'claw-control-plane.service');
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('Requires=docker.service');
  });
});

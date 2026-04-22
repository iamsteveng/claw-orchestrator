#!/usr/bin/env node
// health-server.js — Health endpoint for Claw tenant containers
// Runs on port 3101. GET /health returns 200 (healthy) or 503 (starting).
// No external dependencies — uses Node.js built-ins only.

'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');

const PORT = 3101;
const GATEWAY_PORT = 19001;
const START_TIME = Date.now();

function checkOpenclaw() {
  try {
    // Check /proc for any node process with openclaw in cmdline (pgrep not available in slim image)
    const dirs = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d));
    for (const pid of dirs) {
      try {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (cmdline.includes('openclaw')) return true;
      } catch {}
    }
    return false;
  } catch {
    return false;
  }
}

// Check that the openclaw gateway is accepting TCP connections on its port.
// The process appearing in /proc is not sufficient — the gateway takes ~50s to
// fully initialize. Only once it accepts connections can openclaw agent --local
// connect successfully.
function checkGatewayPort() {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port: GATEWAY_PORT, host: '127.0.0.1' });
    sock.setTimeout(500);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

function checkWritable(path) {
  try {
    fs.accessSync(path, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' || req.url !== '/health') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
    return;
  }

  const checks = {
    openclaw: checkOpenclaw(),
    gateway_port: await checkGatewayPort(),
    workspace_mounted: checkWritable('/workspace'),
    home_mounted: checkWritable('/home/agent'),
    // Check where auth-profiles.json is actually bind-mounted by the control plane
    auth_profiles: fs.existsSync('/home/agent/.openclaw/agents/main/agent/auth-profiles.json'),
  };

  const allOk = checks.openclaw && checks.gateway_port && checks.workspace_mounted && checks.home_mounted;

  res.writeHead(allOk ? 200 : 503, { 'Content-Type': 'application/json' });

  if (allOk) {
    res.end(
      JSON.stringify({
        ok: true,
        status: 'healthy',
        checks,
        uptime_ms: Date.now() - START_TIME,
      })
    );
  } else {
    res.end(
      JSON.stringify({
        ok: false,
        status: 'starting',
        checks,
      })
    );
  }
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`[health-server] Listening on port ${PORT}\n`);
});

#!/usr/bin/env node
// health-server.js — Health endpoint for Claw tenant containers
// Runs on port 3101. GET /health returns 200 (healthy) or 503 (starting).
// No external dependencies — uses Node.js built-ins only.

'use strict';

const http = require('http');
const fs = require('fs');
const { execSync } = require('child_process');

const PORT = 3101;
const START_TIME = Date.now();

function checkOpenclaw() {
  try {
    execSync('pgrep -x openclaw', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function checkWritable(path) {
  try {
    fs.accessSync(path, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/health') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
    return;
  }

  const checks = {
    openclaw: checkOpenclaw(),
    workspace_mounted: checkWritable('/workspace'),
    home_mounted: checkWritable('/home/agent'),
  };

  const allOk = checks.openclaw && checks.workspace_mounted && checks.home_mounted;

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

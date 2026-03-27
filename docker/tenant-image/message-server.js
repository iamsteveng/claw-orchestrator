#!/usr/bin/env node
// message-server.js — Message endpoint for Claw tenant containers
// Runs on port 3100. POST /message forwards messages to the OpenClaw agent.
// No external dependencies — uses Node.js built-ins only.

'use strict';

const http = require('http');
const { spawn } = require('child_process');

const PORT = 3100;
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';

/**
 * Sleep for the given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Forward a message to the openclaw agent via the gateway CLI.
 * @param {string} text - The message text to send
 * @returns {Promise<{response: string, blocks: null}>}
 */
function forwardToOpenclaw(text) {
  return new Promise((resolve, reject) => {
    const child = spawn('openclaw', ['agent', '--local', '--agent', 'main', '--message', text, '--json', '--timeout', '120'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn openclaw: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        // openclaw --json writes output to stderr (stdout may be empty)
        const raw = stderr.trim() || stdout.trim();
        try {
          const parsed = JSON.parse(raw);
          const payloads = parsed.payloads || [];
          const text = payloads.map(p => p.text).filter(Boolean).join('\n').trim();
          // Never send raw JSON meta to the user — only extracted text
          resolve({ response: text || '', blocks: null });
        } catch {
          // Not JSON — return raw output (plain text response)
          resolve({ response: raw, blocks: null });
        }
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `openclaw exited with code ${code}`));
      }
    });

    // No stdin needed — message passed as CLI arg
    child.stdin.end();
  });
}

/**
 * Parse a JSON body from an incoming request.
 * @param {http.IncomingMessage} req
 * @returns {Promise<unknown>}
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Validate that a parsed body matches RelayMessageRequest shape.
 * @param {unknown} body
 * @returns {string | null} error message or null if valid
 */
function validateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object';
  }
  const required = ['messageId', 'slackEventId', 'userId', 'teamId', 'text', 'slackPayload', 'timestamp'];
  for (const field of required) {
    if (!(field in body)) {
      return `Missing required field: ${field}`;
    }
  }
  if (typeof body.text !== 'string') {
    return 'Field "text" must be a string';
  }
  if (typeof body.timestamp !== 'number') {
    return 'Field "timestamp" must be a number';
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/message') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
    return;
  }

  // Validate relay token
  const token = req.headers['x-relay-token'];
  if (!RELAY_TOKEN || token !== RELAY_TOKEN) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    return;
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
    return;
  }

  const validationError = validateBody(body);
  if (validationError) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: validationError }));
    return;
  }

  process.stdout.write(
    JSON.stringify({
      level: 'info',
      msg: 'Received message',
      messageId: body.messageId,
      slackEventId: body.slackEventId,
    }) + '\n'
  );

  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 3000;
  let lastResult = null;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await forwardToOpenclaw(body.text);
      if (result.response) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, response: result.response, blocks: result.blocks }));
        return;
      }
      lastResult = result;
      process.stdout.write(
        JSON.stringify({
          level: 'warn',
          msg: 'openclaw returned empty response',
          messageId: body.messageId,
          attempt,
        }) + '\n'
      );
    } catch (err) {
      lastError = err;
      process.stderr.write(
        JSON.stringify({
          level: 'error',
          msg: 'openclaw error',
          messageId: body.messageId,
          attempt,
          error: err.message,
        }) + '\n'
      );
    }

    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS);
    }
  }

  if (lastError) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: lastError.message }));
  } else {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Agent returned empty response after retries' }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`[message-server] Listening on port ${PORT}\n`);
});

#!/usr/bin/env node
/**
 * Local rebuild helper for Settings → Developer → "Reload extension".
 *   npm run dev:reload
 *
 * Dev builds of the extension POST /rebuild here before calling
 * chrome.runtime.reload(), so the reload picks up the current source instead
 * of whatever was last built into apps/extension/dist. Listens on 127.0.0.1
 * only and accepts requests from chrome-extension:// origins only.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PIGEONBOX_DEV_RELOAD_PORT || 5199);
const OUTPUT_TAIL = 4000;

/** One build at a time; concurrent requests share the running build's result. */
let running = null;

function build() {
  if (running) return running;
  running = new Promise((resolveBuild) => {
    const started = Date.now();
    console.log('[dev-reload] building extension…');
    const child = spawn('npm', ['run', 'build', '-w', '@pigeonbox/extension'], {
      cwd: root,
      shell: process.platform === 'win32',
      env: process.env,
    });
    let output = '';
    const collect = (chunk) => {
      process.stdout.write(chunk);
      output = (output + chunk.toString()).slice(-OUTPUT_TAIL);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => {
      resolveBuild({ ok: false, output: String(error), ms: Date.now() - started });
    });
    child.on('close', (code) => {
      const ms = Date.now() - started;
      console.log(`[dev-reload] build ${code === 0 ? 'succeeded' : 'failed'} in ${ms}ms`);
      resolveBuild({ ok: code === 0, output, ms });
    });
  }).finally(() => {
    running = null;
  });
  return running;
}

function send(res, status, origin, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...(origin
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Private-Network': 'true',
          Vary: 'Origin',
        }
      : {}),
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origin.startsWith('chrome-extension://')) {
    send(res, 403, null, { error: 'forbidden' });
    return;
  }
  const path = new URL(req.url || '/', `http://${HOST}`).pathname;
  if (req.method === 'OPTIONS') {
    send(res, 204, origin);
    return;
  }
  if (req.method === 'GET' && path === '/health') {
    send(res, 200, origin, { ok: true });
    return;
  }
  if (req.method === 'POST' && path === '/rebuild') {
    send(res, 200, origin, await build());
    return;
  }
  send(res, 404, origin, { error: 'not_found' });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[dev-reload] port ${PORT} is already in use. Is dev:reload already running?`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  console.log(`[dev-reload] listening on http://${HOST}:${PORT}`);
  console.log('[dev-reload] Settings → Developer → "Reload extension" now rebuilds before reloading.');
});

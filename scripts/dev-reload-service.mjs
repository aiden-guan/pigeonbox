#!/usr/bin/env node
/**
 * Keeps the dev-reload helper (scripts/dev-reload.mjs) running in the
 * background on macOS via a per-user LaunchAgent, so Settings’
 * "Reload extension" button always rebuilds first.
 *
 *   npm run dev:reload:install     start now and at every login
 *   npm run dev:reload:uninstall   stop and remove
 *   npm run dev:reload:status      is it loaded and answering?
 *
 * The agent points at this checkout; re-run install if the repo moves or
 * Node is upgraded to a different path.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'com.pigeonbox.dev-reload';
const PORT = Number(process.env.PIGEONBOX_DEV_RELOAD_PORT || 5199);
const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const logPath = join(homedir(), 'Library', 'Logs', 'PigeonBox', 'dev-reload.log');
const domain = `gui/${process.getuid?.()}`;

function xml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plist() {
  // launchd starts with a bare PATH; the helper spawns `npm`, so carry over
  // this Node's bin dir plus the usual install locations.
  const path = [dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(join(root, 'scripts', 'dev-reload.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml([...new Set(path)].join(':'))}</string>
    <key>PIGEONBOX_DEV_RELOAD_PORT</key><string>${PORT}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

function launchctl(...args) {
  return spawnSync('launchctl', args, { encoding: 'utf8' });
}

function health() {
  return new Promise((resolveHealth) => {
    const req = request(
      { host: '127.0.0.1', port: PORT, path: '/health', headers: { Origin: 'chrome-extension://dev-reload-service' }, timeout: 1500 },
      (res) => {
        res.resume();
        resolveHealth(res.statusCode === 200);
      },
    );
    req.on('error', () => resolveHealth(false));
    req.on('timeout', () => {
      req.destroy();
      resolveHealth(false);
    });
    req.end();
  });
}

async function waitForHealth(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await health()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function unload() {
  launchctl('bootout', `${domain}/${LABEL}`);
}

async function install() {
  unload();
  if (await health()) {
    console.error(`[dev-reload] something is already answering on 127.0.0.1:${PORT}. Stop your \`npm run dev:reload\` terminal first, then re-run this.`);
    process.exit(1);
  }
  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(plistPath, plist());
  const boot = launchctl('bootstrap', domain, plistPath);
  if (boot.status !== 0) {
    console.error(`[dev-reload] launchctl bootstrap failed:\n${boot.stderr || boot.stdout}`);
    process.exit(1);
  }
  if (await waitForHealth(5000)) {
    console.log(`[dev-reload] running in the background and at every login.
  Settings → Developer → "Reload extension" now rebuilds before reloading.
  Logs:   ${logPath}
  Remove: npm run dev:reload:uninstall`);
  } else {
    console.error(`[dev-reload] installed but not answering yet. Check ${logPath}
  If it says "Operation not permitted", macOS is blocking background access to this folder:
  System Settings → Privacy & Security → Full Disk Access (or Files and Folders) → allow ${process.execPath}`);
    process.exit(1);
  }
}

function uninstall() {
  unload();
  if (existsSync(plistPath)) rmSync(plistPath);
  console.log('[dev-reload] background helper removed. "Reload extension" now does a plain reload unless `npm run dev:reload` is running.');
}

async function status() {
  const loaded = launchctl('print', `${domain}/${LABEL}`).status === 0;
  const answering = await health();
  console.log(`[dev-reload] LaunchAgent: ${loaded ? 'loaded' : existsSync(plistPath) ? 'installed, not loaded' : 'not installed'}`);
  console.log(`[dev-reload] 127.0.0.1:${PORT}: ${answering ? 'answering' : 'not answering'}`);
  if (loaded) console.log(`[dev-reload] logs: ${logPath}`);
  process.exit(answering ? 0 : 1);
}

if (process.platform !== 'darwin') {
  console.error('[dev-reload] background install is macOS-only for now. Keep `npm run dev:reload` open in a terminal instead.');
  process.exit(1);
}

const command = process.argv[2];
if (command === 'install') await install();
else if (command === 'uninstall') uninstall();
else if (command === 'status') await status();
else {
  console.error('usage: node scripts/dev-reload-service.mjs install|uninstall|status');
  process.exit(1);
}

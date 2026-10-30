#!/usr/bin/env node
/**
 * Everything a pull request must pass, in one command.
 *
 *   npm run verify
 *   npm run verify -- --skip-package   (faster; skips the release build and ZIP check)
 *
 * Needs no deployed server, Supabase, Cloudflare, Convex or AI key: server tests run
 * against an in-process WASM Postgres.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skipPackage = process.argv.includes('--skip-package');
const results = [];

function step(name, command, args, env) {
  const started = Date.now();
  process.stdout.write(`\n▸ ${name}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: env ? { ...process.env, ...env } : process.env,
  });
  const ok = result.status === 0;
  results.push({ name, ok, seconds: ((Date.now() - started) / 1000).toFixed(1) });
  if (!ok) finish(1);
}

function finish(code) {
  console.log('\nverify summary');
  for (const { name, ok, seconds } of results) console.log(`  ${ok ? '✓' : '✗'} ${name} (${seconds}s)`);
  process.exit(code);
}

const required = Number(readFileSync(join(root, '.nvmrc'), 'utf8').trim());
const major = Number(process.versions.node.split('.')[0]);
if (major < required) {
  console.error(`Node.js ${required}+ required, found ${process.version}.`);
  process.exit(1);
}
if (!existsSync(join(root, 'node_modules', 'typescript'))) {
  console.error('Dependencies are not installed. Run npm ci first.');
  process.exit(1);
}

step('dependencies match the lockfile', 'npm', ['ls', '--workspaces', '--include-workspace-root', '--depth=0', '--silent']);
step('versions are consistent', process.execPath, ['scripts/check-versions.mjs']);
step('no old package namespace, boundary violations, secrets or tracked env files', process.execPath, ['scripts/check-repo.mjs']);
step('typecheck', 'npm', ['run', 'typecheck', '--silent']);
step('lint', 'npm', ['run', 'lint', '--silent']);
step('tests', 'npm', ['test', '--silent']);
step('build', 'npm', ['run', 'build', '--silent']);
if (!skipPackage) {
  const out = mkdtempSync(join(tmpdir(), 'pigeonbox-verify-'));
  try {
    step('release package builds and validates', process.execPath, ['scripts/package-extension.mjs', '--out', out]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
finish(0);

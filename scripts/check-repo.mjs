#!/usr/bin/env node
/**
 * Repository hygiene checks, run by `npm run verify` and CI.
 *
 *  - namespace: no stale `@gi/*` package references
 *  - boundaries: only extension orchestration talks to the server; the contract stays UI- and DB-free;
 *    nothing in the extension imports server code
 *  - secrets: no credentials in tracked files
 *  - env-files: local env/credential files are ignored, not tracked
 *
 *   node scripts/check-repo.mjs [namespace|boundaries|secrets|env-files]...
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSecrets } from './lib/extension-package.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requested = process.argv.slice(2);
const checks = requested.length ? requested : ['namespace', 'boundaries', 'secrets', 'env-files'];

function trackedFiles() {
  // Tracked plus new, not-ignored files, so a check sees what the next commit would contain.
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('git ls-files failed; run inside the repository.');
  return [...new Set(result.stdout.split('\0').filter(Boolean))];
}

const BINARY = /\.(png|jpe?g|gif|webp|ico|wasm|zip|woff2?|ttf|pdf)$/i;
const files = trackedFiles().filter((file) => !BINARY.test(file));
const read = (file) => {
  try {
    return readFileSync(join(root, file), 'utf8');
  } catch {
    return '';
  }
};

const problems = [];

if (checks.includes('namespace')) {
  // CHANGELOG entries before 0.2.0 describe history under the old names.
  for (const file of files) {
    if (file === 'CHANGELOG.md' || file.startsWith('scripts/check-repo')) continue;
    if (/@gi\//.test(read(file))) problems.push(`[namespace] ${file} still references @gi/*`);
  }
}

if (checks.includes('boundaries')) {
  // See docs/architecture.md, "Dependency direction".
  const importOf = (name) => new RegExp(`(?:from\\s+|import\\s*\\(\\s*)['"]${name}(?:/|['"])`);
  const rules = [
    { dirs: ['gmail', 'mailbox', 'search', 'tracking', 'ai', 'agent', 'core', 'shared'], banned: ['@pigeonbox/cloud-client'], why: 'server access belongs in extension orchestration' },
    { dirs: ['api-contract'], banned: ['react', 'react-dom', '@supabase/supabase-js'], why: 'the server contract stays UI- and database-free' },
    { dirs: ['gmail', 'mailbox', 'search', 'tracking', 'ai', 'agent', 'core', 'shared', 'api-contract', 'cloud-client', 'extension'], banned: ['@pigeonbox/server'], why: 'server code (with its secrets handling) never ships in the extension' },
  ];
  for (const file of files) {
    const match = file.match(/^(?:packages|apps)\/([^/]+)\/src\/.*\.tsx?$/);
    if (!match) continue;
    for (const rule of rules) {
      if (!rule.dirs.includes(match[1])) continue;
      for (const name of rule.banned) {
        if (importOf(name).test(read(file))) problems.push(`[boundaries] ${file} imports ${name}: ${rule.why}`);
      }
    }
  }
}

if (checks.includes('secrets')) {
  for (const file of files) {
    if (file === 'package-lock.json') continue;
    for (const hit of findSecrets(file, Buffer.from(read(file)))) problems.push(`[secrets] ${hit}`);
  }
}

if (checks.includes('env-files')) {
  const forbidden = [
    /(^|\/)\.env$/,
    /(^|\/)\.env\.(?!example$)[^/]+$/,
    /(^|\/)\.dev\.vars$/,
    /^server\.env$/,
    /(^|\/)tracker-config\.json$/,
    /^\.local\//,
    /\.pem$/,
    /(^|\/)\.wrangler\//,
    /(^|\/)release\/.*\.zip$/,
  ];
  const all = trackedFiles();
  for (const file of all) {
    if (forbidden.some((re) => re.test(file))) problems.push(`[env-files] ${file} must not be committed`);
  }
  const ignore = read('.gitignore');
  for (const entry of ['.env', '.env.local', '.dev.vars', 'server.env', 'apps/extension/public/tracker-config.json', '.local/']) {
    if (!ignore.split('\n').some((line) => line.trim() === entry)) problems.push(`[env-files] .gitignore does not list ${entry}`);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problem(s).`);
  process.exit(1);
}
console.log(`Repository checks passed: ${checks.join(', ')}.`);

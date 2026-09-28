#!/usr/bin/env node
/**
 * Repository hygiene checks, run by `npm run verify` and CI.
 *
 *  - namespace: no stale `@gi/*` package references
 *  - private-imports: the public repo never imports PigeonBox Cloud source
 *  - boundaries: only extension orchestration talks to Cloud; the contract stays UI- and DB-free
 *  - secrets: no credentials in tracked files
 *  - env-files: local env/credential files are ignored, not tracked
 *
 *   node scripts/check-repo.mjs [namespace|private-imports|boundaries|secrets|env-files]...
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSecrets } from './lib/extension-package.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requested = process.argv.slice(2);
const checks = requested.length ? requested : ['namespace', 'private-imports', 'boundaries', 'secrets', 'env-files'];

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

if (checks.includes('private-imports')) {
  const privateRef = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:@pigeonbox-cloud\/|pigeonbox-cloud(?:\/|['"])|(?:\.\.\/)+pigeonbox-cloud\/)/;
  for (const file of files) {
    if (!/\.(m?[jt]sx?|cjs)$/.test(file)) continue;
    if (privateRef.test(read(file))) problems.push(`[private-imports] ${file} imports PigeonBox Cloud source`);
  }
  for (const file of files.filter((f) => f.endsWith('package.json'))) {
    const pkg = JSON.parse(read(file) || '{}');
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies };
    for (const [name, spec] of Object.entries(deps)) {
      if (/pigeonbox-cloud/.test(name) || /pigeonbox-cloud/.test(String(spec))) problems.push(`[private-imports] ${file} depends on ${name}`);
    }
  }
}

if (checks.includes('boundaries')) {
  // See docs/architecture.md, "Dependency direction".
  const importOf = (name) => new RegExp(`(?:from\\s+|import\\s*\\(\\s*)['"]${name}(?:/|['"])`);
  const rules = [
    { dirs: ['gmail', 'mailbox', 'search', 'tracking', 'ai', 'agent', 'core', 'shared'], banned: ['@pigeonbox/cloud-client'], why: 'Cloud access belongs in extension orchestration' },
    { dirs: ['api-contract'], banned: ['react', 'react-dom', '@supabase/supabase-js'], why: 'the Cloud contract stays UI- and database-free' },
  ];
  for (const file of files) {
    const match = file.match(/^packages\/([^/]+)\/src\/.*\.tsx?$/);
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
  for (const entry of ['.env', '.env.local', '.dev.vars', 'apps/extension/public/tracker-config.json', '.local/']) {
    if (!ignore.split('\n').some((line) => line.trim() === entry)) problems.push(`[env-files] .gitignore does not list ${entry}`);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problem(s).`);
  process.exit(1);
}
console.log(`Repository checks passed: ${checks.join(', ')}.`);

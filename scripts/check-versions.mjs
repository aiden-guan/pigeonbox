#!/usr/bin/env node
/**
 * Every workspace package, the root package and manifest.json carry one version,
 * and CHANGELOG.md has a section for it.
 *
 *   node scripts/check-versions.mjs            check consistency
 *   node scripts/check-versions.mjs v0.2.0     also require this tag to match (release CI)
 *   node scripts/check-versions.mjs --set 0.3.0  write a new version everywhere
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function workspacePackages() {
  const paths = ['package.json'];
  for (const dir of ['apps', 'packages', 'workers']) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const pkg = join(dir, name, 'package.json');
      if (existsSync(join(root, pkg))) paths.push(pkg);
    }
  }
  return paths;
}

const MANIFEST = 'apps/extension/manifest.json';
const SEMVER = /^\d+\.\d+\.\d+$/;

if (args[0] === '--set') {
  const next = args[1];
  if (!SEMVER.test(next ?? '')) {
    console.error('Usage: node scripts/check-versions.mjs --set X.Y.Z');
    process.exit(2);
  }
  for (const file of [...workspacePackages(), MANIFEST]) {
    const path = join(root, file);
    const json = JSON.parse(readFileSync(path, 'utf8'));
    json.version = next;
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  }
  console.log(`Set version ${next}. Run npm install to update package-lock.json.`);
  process.exit(0);
}

const versions = new Map();
for (const file of [...workspacePackages(), MANIFEST]) {
  versions.set(file, JSON.parse(readFileSync(join(root, file), 'utf8')).version);
}
const expected = versions.get('package.json');
const problems = [];
if (!SEMVER.test(expected ?? '')) problems.push(`root version ${expected} is not X.Y.Z`);
for (const [file, version] of versions) if (version !== expected) problems.push(`${file} is ${version}, expected ${expected}`);
const tag = args.find((arg) => /^v?\d/.test(arg));
if (tag && tag.replace(/^v/, '') !== expected) problems.push(`tag ${tag} does not match version ${expected}`);
const changelog = join(root, 'CHANGELOG.md');
if (existsSync(changelog) && !new RegExp(`^## \\[${expected?.replace(/\./g, '\\.')}\\]`, 'm').test(readFileSync(changelog, 'utf8'))) {
  problems.push(`CHANGELOG.md has no "## [${expected}]" section`);
}
const lock = join(root, 'package-lock.json');
if (existsSync(lock) && JSON.parse(readFileSync(lock, 'utf8')).version !== expected) problems.push('package-lock.json version is stale; run npm install');

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`Versions consistent: ${expected}${tag ? ` (tag ${tag})` : ''}.`);

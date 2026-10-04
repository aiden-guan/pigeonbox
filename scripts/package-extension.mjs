#!/usr/bin/env node
/**
 * Build and package the extension for the Chrome Web Store and GitHub Releases.
 *
 *   npm run package                 release build, validate, write release/PigeonBox-vX.Y.Z.zip + .sha256
 *   npm run package -- --cloud      configured Cloud beta (separate from the Local store release)
 *   npm run package -- --skip-build --from <dir> validate and package an existing release build
 *   npm run package -- --out <dir>  write artifacts somewhere else
 *
 * The release build sets PIGEONBOX_RELEASE=1: no source maps, no experimental
 * features, no machine-local tracker config.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFiles, isExcludedFromPackage, localSecretValues, validatePackage, vendorPublicValues } from './lib/extension-package.mjs';
import { createZip, listZipEntries } from './lib/zip.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const cloudBuild = args.includes('--cloud');
const skipBuild = args.includes('--skip-build');
const outIndex = args.indexOf('--out');
const fromIndex = args.indexOf('--from');
if (outIndex >= 0 && (!args[outIndex + 1] || args[outIndex + 1].startsWith('--'))) fail('--out requires an output directory.');
if (skipBuild && (fromIndex < 0 || !args[fromIndex + 1] || args[fromIndex + 1].startsWith('--'))) fail('--skip-build requires --from <dir> for an existing release build.');
if (!skipBuild && fromIndex >= 0) fail('--from is only supported with --skip-build.');
const outDir = outIndex >= 0 ? resolve(args[outIndex + 1]) : join(root, 'release');
// Packaging never replaces the folder Chrome loads. Each build gets clean,
// isolated staging and removes it on success or failure.
const staging = skipBuild ? null : mkdtempSync(join(tmpdir(), 'pigeonbox-package-'));
const dist = staging ? join(staging, 'extension') : resolve(args[fromIndex + 1]);
if (staging) process.on('exit', () => rmSync(staging, { recursive: true, force: true }));

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const version = JSON.parse(readFileSync(join(root, 'apps', 'extension', 'package.json'), 'utf8')).version;

if (!skipBuild) {
  console.log(`Building PigeonBox ${version} (release)…`);
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env, PIGEONBOX_RELEASE: '1', PIGEONBOX_OUT_DIR: dist, VITE_PIGEONBOX_EXPERIMENTAL: 'false',
      ...(!cloudBuild ? { VITE_PIGEONBOX_CLOUD_API_URL: '', VITE_PIGEONBOX_CLOUD_TRACKER_URL: '', VITE_PIGEONBOX_CLOUD_TRACKER_PREVIOUS_URLS: '' } : {}),
    },
  });
  if (result.status !== 0) fail('Release build failed.');
}

if (!existsSync(join(dist, 'manifest.json'))) fail(`No manifest.json in ${dist}. Run npm run package without --skip-build to build from source.`);

const all = collectFiles(dist);
const files = all.filter((file) => !isExcludedFromPackage(file.name));
const skipped = all.length - files.length;
const problems = validatePackage(files, {
  expectedVersion: version,
  forbiddenValues: localSecretValues(root),
  allowedValues: vendorPublicValues(root),
});
if (problems.length) {
  console.error('Package validation failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const zip = createZip(files);
// Re-read the archive to prove what shipped.
const entries = listZipEntries(zip);
const leaked = entries.filter(isExcludedFromPackage);
if (leaked.length) fail(`Refusing to write an archive containing: ${leaked.join(', ')}`);

mkdirSync(outDir, { recursive: true });
const base = `PigeonBox-v${version}`;
const zipPath = join(outDir, `${base}.zip`);
const shaPath = join(outDir, `${base}.sha256`);
writeFileSync(zipPath, zip);
const sha = createHash('sha256').update(zip).digest('hex');
writeFileSync(shaPath, `${sha}  ${base}.zip\n`);

const mb = (zip.length / (1024 * 1024)).toFixed(1);
console.log(`\nPackaged ${entries.length} files (${mb} MB)${skipped ? `, left out ${skipped} dev-only files` : ''}.`);
console.log(`  ${zipPath}`);
console.log(`  ${shaPath}`);
console.log(`  sha256 ${sha}`);

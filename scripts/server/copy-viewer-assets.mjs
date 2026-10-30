#!/usr/bin/env node
/**
 * Copies the pinned pdf.js build into the account site's static assets for the
 * tracked-document viewer (served from the same origin, so the viewer's CSP
 * stays `script-src 'self'`). The target folder is generated and gitignored.
 *
 *   node scripts/server/copy-viewer-assets.mjs
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(root, 'workers', 'api', 'package.json'));
const source = dirname(require.resolve('pdfjs-dist/package.json'));
const { version } = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
const target = join(root, 'apps', 'web', 'public', 'viewer', 'pdfjs');
const stamp = join(target, 'VERSION');

if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === version) {
  console.log(`pdf.js ${version} already in place`);
  process.exit(0);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const file of ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs', 'LICENSE']) cpSync(join(source, file), join(target, file.replace(/^build\//, '')));
// Character maps and standard fonts for PDFs that do not embed them; WASM image and colour decoders.
for (const folder of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) cpSync(join(source, folder), join(target, folder), { recursive: true });
writeFileSync(stamp, `${version}\n`);
console.log(`Copied pdf.js ${version} to ${target}`);

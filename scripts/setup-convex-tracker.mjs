#!/usr/bin/env node
/**
 * Set up the recommended public tracker in the user's own Convex account.
 * Run after `npm run setup`; this writes only ignored, machine-local files.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from './lib/extension-package.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const openAfter = process.argv.includes('--open');
const captureDeploymentUrl = process.argv.includes('--capture-deployment-url');
const envPath = join(root, '.env');
const convexStatePath = join(root, '.env.local');
const localDir = join(root, '.local');
const configPath = join(root, 'apps', 'extension', 'public', 'tracker-config.json');
const siteUrlPath = join(localDir, 'convex-tracker-site-url.txt');
const managedBy = 'pigeonbox-convex-setup';
const placeholderToken = 'generate-a-long-random-token';

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function run(command, args, shell = process.platform === 'win32', stdio = 'inherit') {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio,
    shell,
  });
  if (result.error) fail(`${command} could not be started: ${result.error.message}`);
  return result.status ?? 1;
}

function runNpm(args, stdio = 'inherit') {
  const npmCliPath = process.env.npm_execpath;
  if (npmCliPath) return run(process.execPath, [npmCliPath, ...args], false, stdio);
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, undefined, stdio);
}

function runNpx(args, stdio = 'inherit') {
  return runNpm(['exec', '--', ...args], stdio);
}

function parseEnv(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return values;
}

function captureSiteUrl() {
  const rawUrl = process.env.PIGEONBOX_CONVEX_URL;
  if (!rawUrl) fail('Convex did not provide its production deployment URL.');
  let deploymentUrl;
  try {
    deploymentUrl = new URL(rawUrl);
  } catch {
    fail('Convex provided an invalid production deployment URL.');
  }
  if (deploymentUrl.protocol !== 'https:' || !deploymentUrl.hostname.endsWith('.convex.cloud')) {
    fail('The production deployment URL is not a hosted Convex cloud URL.');
  }
  deploymentUrl.hostname = deploymentUrl.hostname.replace(/\.convex\.cloud$/, '.convex.site');
  deploymentUrl.pathname = '';
  deploymentUrl.search = '';
  deploymentUrl.hash = '';
  mkdirSync(localDir, { recursive: true });
  writeFileSync(siteUrlPath, `${deploymentUrl.origin}\n`, { mode: 0o600 });
  chmodSync(siteUrlPath, 0o600);
  console.log(`Captured Convex production HTTP actions URL: ${deploymentUrl.origin}`);
}

async function askToProvision({ replacesExistingConfig }) {
  if (process.argv.includes('--yes')) {
    console.log('\nUsing the user\'s prior approval for Convex tracker setup.');
    return true;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail(
      'Public tracker setup needs approval before the cloud deployment.\n' +
        'Ask the user first, then rerun with `--yes`, or use an interactive terminal and approve its prompt.\n' +
        'Cloudflare + Supabase is documented in docs/self-hosting.md.',
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\nSet up the recommended public tracker in your Convex account?');
    console.log('The setup opens Convex sign-in, creates or uses a project, sets or replaces a production secret, deploys the tracking backend, and configures this local extension build.');
    console.log('The tracker stores subject/sender/recipient metadata and open/click events, not message bodies or drafts. Convex account limits and terms apply.');
    if (replacesExistingConfig) console.log('An existing local tracker config will be replaced after the deployment succeeds.');
    const answer = await rl.question('Continue? [y/N] ');
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

async function waitForTracker(siteUrl) {
  let lastProblem = 'no response';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const response = await fetch(`${siteUrl}/health`, { signal: AbortSignal.timeout(5000) });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.protocolVersion === 3) return;
      lastProblem = `HTTP ${response.status}; protocol version ${body?.protocolVersion ?? 'unavailable'}`;
    } catch (error) {
      lastProblem = error instanceof Error ? error.name : 'request failed';
    }
    if (attempt < 7) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500));
  }
  fail(
    `The tracker was deployed, but ${siteUrl}/health did not report protocol version 3 (${lastProblem}).\n` +
      'The deployment URL is saved in .local/convex-tracker-site-url.txt. Check the Convex dashboard, then run `npm run setup:tracker` again.',
  );
}

function validateBuiltExtension() {
  const dist = join(root, 'apps', 'extension', 'dist');
  const manifestPath = join(dist, 'manifest.json');
  if (!existsSync(manifestPath)) fail('Build finished, but apps/extension/dist/manifest.json is missing.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const builtFiles = new Set();
  const visit = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(join(dir, entry.name), name);
      else builtFiles.add(name);
    }
  };
  visit(dist);
  const problems = validateManifest(manifest, builtFiles);
  if (problems.length) fail(`The built manifest has problems:\n  ${problems.join('\n  ')}`);
  if (!existsSync(join(dist, 'tracker-config.json'))) {
    fail('The tracker was deployed, but tracker-config.json is missing from the built extension.');
  }
}

async function main() {
  if (captureDeploymentUrl) {
    captureSiteUrl();
    return;
  }

  if (!existsSync(envPath)) fail('Missing .env. Run `npm run setup` first.');
  if (!existsSync(join(root, 'node_modules', 'convex')) || !existsSync(join(root, 'node_modules', 'typescript'))) {
    fail('Dependencies are not installed. Run `npm run setup` first.');
  }

  const envToken = parseEnv(readFileSync(envPath, 'utf8')).PERSONAL_API_TOKEN;
  const devVarsPath = join(root, 'workers', 'tracker', '.dev.vars');
  const devVarsToken = existsSync(devVarsPath)
    ? parseEnv(readFileSync(devVarsPath, 'utf8')).PERSONAL_API_TOKEN
    : '';
  const isUsableToken = (value) => Boolean(value && !value.includes(placeholderToken) && !/[\r\n]/.test(value));
  const token = isUsableToken(devVarsToken) ? devVarsToken : envToken;
  if (!isUsableToken(token)) {
    fail('No usable PERSONAL_API_TOKEN is configured in .env or workers/tracker/.dev.vars. Run `npm run setup` first.');
  }

  let replacesExistingConfig = false;
  if (existsSync(configPath)) {
    let existingConfig;
    try {
      existingConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      fail('An existing tracker-config.json could not be read. It was left unchanged.');
    }
    if (!existingConfig || typeof existingConfig !== 'object') {
      fail('An existing tracker-config.json is invalid. It was left unchanged.');
    }
    replacesExistingConfig = existingConfig.managedBy !== managedBy;
  }

  const hadConvexState = existsSync(convexStatePath);
  if (hadConvexState) {
    const convexState = parseEnv(readFileSync(convexStatePath, 'utf8'));
    if (!convexState.CONVEX_DEPLOYMENT || !convexState.CONVEX_URL) {
      fail('.env.local already exists but does not contain a recognizable Convex project. It was left unchanged.');
    }
  }

  const approved = await askToProvision({ replacesExistingConfig });
  if (!approved) {
    console.log('\nSkipped Convex setup. Local inbox and AI features are ready; recipient tracking needs a public tracker.');
    console.log('To set it up later, run `npm run setup:tracker -- --open`. Cloudflare + Supabase is documented in docs/self-hosting.md.');
    if (openAfter && run(process.execPath, [join(root, 'scripts', 'open.mjs')]) !== 0) process.exit(1);
    return;
  }

  console.log('\nSigning in to Convex…\n');
  if (runNpx(['convex', 'login']) !== 0) fail('Convex sign-in did not complete. No tracker credentials were changed.');

  console.log('\nPreparing the Convex project…\n');
  const devArgs = hadConvexState
    ? ['convex', 'dev', '--once']
    : ['convex', 'dev', '--configure', 'new', '--dev-deployment', 'cloud', '--once'];
  if (runNpx(devArgs) !== 0) fail('Convex project setup did not complete. No production token was changed.');
  if (!existsSync(convexStatePath) || !parseEnv(readFileSync(convexStatePath, 'utf8')).CONVEX_DEPLOYMENT) {
    fail('Convex did not save its local deployment settings in .env.local.');
  }

  mkdirSync(localDir, { recursive: true });
  const secretFile = join(localDir, 'convex-tracker.env');
  writeFileSync(secretFile, `PERSONAL_API_TOKEN=${token}\n`, { mode: 0o600 });
  chmodSync(secretFile, 0o600);

  console.log('\nDeploying the production tracker…\n');
  if (
    runNpx([
      'convex',
      'deploy',
      '--cmd',
      'node scripts/setup-convex-tracker.mjs --capture-deployment-url',
      '--cmd-url-env-var-name',
      'PIGEONBOX_CONVEX_URL',
    ]) !== 0
  ) {
    fail('Convex production deployment did not complete. Rerun `npm run setup:tracker` to continue.');
  }

  if (!existsSync(siteUrlPath)) fail('Convex deploy completed without recording its public HTTP actions URL.');
  const siteUrl = readFileSync(siteUrlPath, 'utf8').trim().replace(/\/$/, '');

  console.log('\nSetting the production tracker token from a private local file…\n');
  if (
    runNpx(
      ['convex', 'env', 'set', '--prod', '--force', '--from-file', '.local/convex-tracker.env'],
      ['inherit', 'pipe', 'pipe'],
    ) !== 0
  ) {
    fail('The production tracker token could not be set. The token was not printed. Rerun setup after resolving the Convex CLI error.');
  }

  console.log(`\nChecking ${siteUrl}/health…`);
  await waitForTracker(siteUrl);

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify({ managedBy, trackerBaseUrl: siteUrl, personalApiToken: token }, null, 2)}\n`,
    { mode: 0o600 },
  );
  chmodSync(configPath, 0o600);

  console.log('\nBuilding the extension with its local tracker configuration…\n');
  if (runNpm(['run', 'build']) !== 0) fail('The tracker is live, but the extension rebuild failed. Rerun `npm run setup:tracker`.');
  validateBuiltExtension();

  console.log(
    `\nConvex tracker is healthy at ${siteUrl} and prefilled in this local extension build.\n` +
      'The tracker URL and token are stored in ignored local files; they are excluded from release builds.\n' +
      'After loading the extension, open Settings → Email tracking, click Save, and approve Chrome’s tracker access prompt.\n',
  );
  if (openAfter && run(process.execPath, [join(root, 'scripts', 'open.mjs')]) !== 0) process.exit(1);
}

await main().catch((error) => {
  fail(error instanceof Error ? error.message : 'Tracker setup failed.');
});

#!/usr/bin/env node
/**
 * Deploy (or update) your PigeonBox server from server.env:
 *
 *   npm run server:deploy             migrate Supabase, deploy both Workers, point the extension at them
 *   npm run server:deploy -- --dry-run validate and bundle locally; nothing leaves this computer
 *
 * Needs a Cloudflare login (`npx wrangler login`) and a Supabase project. Everything
 * this writes is gitignored: .local/server-secrets.json (generated encryption key and
 * salts; back it up), .local/server.json, .local/wrangler/ and apps/extension/.env.local.
 * See docs/self-hosting.md.
 */
import { spawn } from 'node:child_process';
import { generateKeyPairSync, createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dryRun = process.argv.includes('--dry-run');
const localDir = join(root, '.local');
const wranglerDir = join(localDir, 'wrangler');
const envPath = join(root, 'server.env');
const secretsPath = join(localDir, 'server-secrets.json');
const statePath = join(localDir, 'server.json');
const extensionEnvPath = join(root, 'apps', 'extension', '.env.local');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

/** Non-secret settings copied from server.env into the Workers' vars when present. */
const PASSTHROUGH_VARS = [
  'CLOUD_AI_FALLBACK_MODELS', 'CLOUD_AI_TIMEOUT_MS', 'CLOUD_AI_BACKGROUND_TIER', 'CLOUD_AI_FLEX_TIMEOUT_MS',
  'CLOUD_AI_DAILY_REQUEST_LIMIT', 'CLOUD_AI_RATE_LIMIT_PER_MINUTE', 'CLOUD_AI_GLOBAL_DAILY_TOKEN_BUDGET', 'CLOUD_AI_BACKGROUND_DAILY_LIMIT',
  'CLOUD_AI_MONTHLY_BUDGET_MICROS', 'CLOUD_AI_MONTHLY_TOKEN_LIMIT', 'CLOUD_AI_INPUT_COST_PER_1K_MICROS', 'CLOUD_AI_CACHED_INPUT_COST_PER_1K_MICROS',
  'CLOUD_AI_OUTPUT_COST_PER_1K_MICROS', 'CLOUD_AI_FLEX_INPUT_COST_PER_1K_MICROS', 'CLOUD_AI_FLEX_CACHED_INPUT_COST_PER_1K_MICROS', 'CLOUD_AI_FLEX_OUTPUT_COST_PER_1K_MICROS',
  'MAX_MAIL_ACCOUNTS', 'SYNC_BACKFILL_DAYS', 'DOCUMENT_MAX_BYTES', 'SEQUENCES_ENABLED', 'SEQUENCE_DAILY_LIMIT', 'WEB_SEARCH_PROVIDER',
  'MCP_OAUTH_ENABLED', 'COMPOSE_NOTICE_POLICY', 'CLIENT_CONFIG', 'CLOUD_ROLLOUT',
];
const REQUIRED = ['ALLOWED_EMAILS', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL', 'CLOUD_AI_BASE_URL', 'CLOUD_AI_API_KEY', 'CLOUD_AI_PRIMARY_MODEL'];
const PUBSUB = ['GOOGLE_PUBSUB_TOPIC', 'GOOGLE_PUBSUB_SERVICE_ACCOUNT'];

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function step(message) {
  console.log(`\n→ ${message}`);
}

function parseEnv(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    values[trimmed.slice(0, eq).trim()] = value;
  }
  return values;
}

function writePrivate(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Runs a command, echoing its output while keeping a copy, with stdin left to the person (wrangler may prompt). */
function run(command, args, { capture = false } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: root, stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'], shell: process.platform === 'win32' });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.on('error', (error) => fail(`${command} could not be started: ${error.message}`));
    child.on('close', (code) => resolvePromise({ code: code ?? 1, output }));
  });
}

const npx = (args, options) => run(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, options);
const npm = (args, options) => run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, options);

function httpsOrigin(name, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${name} in server.env is not a URL.`);
  }
  if (url.protocol !== 'https:') fail(`${name} in server.env must start with https://`);
  return url.origin;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function loadServerEnv() {
  if (!existsSync(envPath)) {
    copyFileSync(join(root, 'server.env.example'), envPath);
    chmodSync(envPath, 0o600);
    fail('Created server.env from server.env.example. Fill it in (docs/self-hosting.md lists where each value comes from), then run `npm run server:deploy` again.');
  }
  const env = parseEnv(readFileSync(envPath, 'utf8'));
  const missing = REQUIRED.filter((key) => !env[key] || /YOUR-|^replace-/.test(env[key]));
  if (missing.length) fail(`server.env is missing: ${missing.join(', ')}. See docs/self-hosting.md.`);
  httpsOrigin('SUPABASE_URL', env.SUPABASE_URL);
  httpsOrigin('CLOUD_AI_BASE_URL', env.CLOUD_AI_BASE_URL);
  if (!/^postgres(ql)?:\/\//.test(env.DATABASE_URL)) fail('DATABASE_URL in server.env must be a postgres:// connection string (Supabase → Connect → Transaction pooler).');
  const pubsub = PUBSUB.filter((key) => env[key]);
  if (pubsub.length && pubsub.length !== PUBSUB.length) fail(`Always-on Gmail needs both ${PUBSUB.join(' and ')}, or neither.`);
  if (pubsub.length && !(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)) fail('Always-on Gmail needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET too.');
  return env;
}

/** Generated once and reused: changing DATA_ENCRYPTION_KEYS would make stored data unreadable. */
function loadSecrets() {
  const existing = existsSync(secretsPath) ? JSON.parse(readFileSync(secretsPath, 'utf8')) : {};
  const secrets = {
    DATA_ENCRYPTION_KEYS: existing.DATA_ENCRYPTION_KEYS ?? `k1:${randomBytes(32).toString('base64')}`,
    IP_HASH_SALT: existing.IP_HASH_SALT ?? randomBytes(32).toString('base64url'),
    INTERNAL_JOB_SECRET: existing.INTERNAL_JOB_SECRET ?? randomBytes(32).toString('base64url'),
  };
  if (!existing.DATA_ENCRYPTION_KEYS) console.log(`Generated server secrets in ${secretsPath}. Back this file up: without it, stored mail data cannot be decrypted.`);
  if (!dryRun) writePrivate(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`);
  return secrets;
}

function extensionIdFromKey(key) {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

function readExtensionEnv() {
  return existsSync(extensionEnvPath) ? readFileSync(extensionEnvPath, 'utf8') : '';
}

function setExtensionEnv(values) {
  let text = readExtensionEnv();
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    text = pattern.test(text) ? text.replace(pattern, line) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
  }
  writePrivate(extensionEnvPath, text);
}

/**
 * The server only lets known extension IDs sign in. A manifest key gives the
 * unpacked build a stable ID; without one, Chrome derives it from the folder path.
 */
function extensionId(env) {
  if (env.EXTENSION_ID) {
    if (!/^[a-p]{32}$/.test(env.EXTENSION_ID)) fail('EXTENSION_ID in server.env must be the 32-letter ID from chrome://extensions.');
    return env.EXTENSION_ID;
  }
  const saved = parseEnv(readExtensionEnv()).PIGEONBOX_EXTENSION_KEY;
  if (saved) return extensionIdFromKey(saved.replace(/-----(BEGIN|END) PUBLIC KEY-----|\s+/g, ''));
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  if (!dryRun) {
    writePrivate(join(localDir, 'extension-key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
    setExtensionEnv({ PIGEONBOX_EXTENSION_KEY: key });
    console.log('Gave the unpacked extension a stable ID (PIGEONBOX_EXTENSION_KEY in apps/extension/.env.local).');
    console.log('If you already loaded PigeonBox unpacked, Chrome will treat the rebuilt one as a new extension once: settings and the local index start fresh.');
  }
  return extensionIdFromKey(key);
}

// ---------------------------------------------------------------------------
// Wrangler configuration
// ---------------------------------------------------------------------------

const toml = (value) => JSON.stringify(String(value));
const vars = (entries) => Object.entries(entries).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => `${key} = ${toml(value)}`).join('\n');

function common(name, main) {
  return `# Generated by scripts/server/deploy.mjs from server.env. Do not edit; edit server.env and redeploy.
name = ${toml(name)}
main = ${toml(main)}
compatibility_date = "2025-09-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = true

[observability]
enabled = true

[observability.logs]
enabled = true
invocation_logs = false
`;
}

function limits(env) {
  return env.WORKERS_PAID === 'true' ? '\n[limits]\ncpu_ms = 30_000\nsubrequests = 10_000\n' : '';
}

function apiConfig(env, names, urls, extension, commit) {
  const alwaysOn = PUBSUB.every((key) => env[key]);
  return `${common(names.api, '../../workers/api/src/index.ts')}${limits(env)}
# The dashboard (apps/web). API routes always reach the Worker.
[assets]
directory = "../../apps/web/public"
run_worker_first = ["/v1/*", "/d/*", "/u/*", "/internal/*", "/.well-known/*"]
html_handling = "auto-trailing-slash"
not_found_handling = "404-page"

# Drains durable jobs (Supabase Queues) every minute; Supabase Cron enqueues scheduled work.
[triggers]
crons = ["* * * * *"]
${env.HYPERDRIVE_ID ? `\n[[hyperdrive]]\nbinding = "HYPERDRIVE"\nid = ${toml(env.HYPERDRIVE_ID)}\n` : ''}
[vars]
${vars({
  ENVIRONMENT: 'production',
  SERVICE_VERSION: version,
  SERVICE_COMMIT: commit,
  AUTH_PROVIDER: 'supabase',
  DATA_STORE: 'supabase',
  SUPABASE_URL: env.SUPABASE_URL,
  API_BASE_URL: urls.api,
  PUBLIC_APP_URL: urls.api,
  ALLOWED_WEB_ORIGINS: urls.api,
  TRACKER_BASE_URL: urls.tracker,
  ALLOWED_EXTENSION_IDS: [extension, env.EXTRA_EXTENSION_IDS].filter(Boolean).join(','),
  ALLOWED_EMAILS: env.ALLOWED_EMAILS,
  CLOUD_AI_PROVIDER: env.CLOUD_AI_PROVIDER || 'openai_compatible',
  CLOUD_AI_BASE_URL: env.CLOUD_AI_BASE_URL,
  CLOUD_AI_PRIMARY_MODEL: env.CLOUD_AI_PRIMARY_MODEL,
  CLOUD_AI_EMBED_MODEL: env.CLOUD_AI_EMBED_MODEL,
  DOCUMENTS_BUCKET: env.DOCUMENTS_BUCKET,
  ...(alwaysOn ? {
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    GOOGLE_PUBSUB_TOPIC: env.GOOGLE_PUBSUB_TOPIC,
    GOOGLE_PUBSUB_AUDIENCE: `${urls.api}/v1/google/push`,
    GOOGLE_PUBSUB_SERVICE_ACCOUNT: env.GOOGLE_PUBSUB_SERVICE_ACCOUNT,
  } : {}),
  ...Object.fromEntries(PASSTHROUGH_VARS.map((key) => [key, env[key]])),
})}
`;
}

function apiSecrets(env, secrets) {
  const alwaysOn = PUBSUB.every((key) => env[key]);
  return Object.fromEntries(Object.entries({
    SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_JWT_SECRET: env.SUPABASE_JWT_SECRET,
    DATABASE_URL: env.HYPERDRIVE_ID ? undefined : env.DATABASE_URL,
    CLOUD_AI_API_KEY: env.CLOUD_AI_API_KEY,
    CLOUD_AI_GATEWAY_TOKEN: env.CLOUD_AI_GATEWAY_TOKEN,
    GOOGLE_CLIENT_SECRET: alwaysOn ? env.GOOGLE_CLIENT_SECRET : undefined,
    WEB_SEARCH_API_KEY: env.WEB_SEARCH_API_KEY,
    ...secrets,
  }).filter(([, value]) => value));
}

function trackerConfig(env, names, commit) {
  const queue = env.TRACKER_QUEUE === 'true';
  return `${common(names.tracker, '../../workers/server-tracker/src/index.ts')}
[vars]
${vars({
  ENVIRONMENT: 'production',
  SERVICE_VERSION: version,
  SERVICE_COMMIT: commit,
  AUTH_PROVIDER: 'supabase',
  DATA_STORE: 'supabase',
  SUPABASE_URL: env.SUPABASE_URL,
  ALLOWED_EMAILS: env.ALLOWED_EMAILS,
})}
${queue ? `
# Pixel and click events go through a queue so a slow database never delays a recipient's mail client.
[[queues.producers]]
binding = "TRACKING_EVENTS"
queue = ${toml(names.queue)}

[[queues.consumers]]
queue = ${toml(names.queue)}
max_batch_size = 20
max_batch_timeout = 1
max_retries = 7
dead_letter_queue = ${toml(`${names.queue}-dead`)}
max_concurrency = 5
` : ''}`;
}

function trackerSecrets(env, secrets) {
  return Object.fromEntries(Object.entries({
    SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_JWT_SECRET: env.SUPABASE_JWT_SECRET,
    IP_HASH_SALT: secrets.IP_HASH_SALT,
  }).filter(([, value]) => value));
}

/** Deploys one Worker with its secrets in the same version; the secrets file exists only for the call. */
async function deployWorker(label, configText, secrets) {
  const config = join(wranglerDir, `${label}.toml`);
  writePrivate(config, configText);
  if (dryRun) {
    const { code } = await npx(['wrangler', 'deploy', '--config', config, '--dry-run', '--outdir', join(wranglerDir, `${label}-bundle`)]);
    if (code !== 0) fail(`Bundling the ${label} Worker failed.`);
    return null;
  }
  const secretsFile = join(wranglerDir, `${label}.secrets.json`);
  writePrivate(secretsFile, JSON.stringify(secrets));
  try {
    const { code, output } = await npx(['wrangler', 'deploy', '--config', config, '--secrets-file', secretsFile], { capture: true });
    if (code !== 0) fail(`Deploying the ${label} Worker failed (see the wrangler output above).`);
    return output.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/)?.[0] ?? null;
  } finally {
    rmSync(secretsFile, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

/**
 * Applies supabase/migrations in order, recording them where the Supabase CLI
 * does (supabase_migrations.schema_migrations), so `supabase db push` agrees.
 */
async function migrate(databaseUrl) {
  const { default: postgres } = await import('postgres');
  const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });
  try {
    await sql.unsafe('create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text)');
    const applied = new Set((await sql`select version from supabase_migrations.schema_migrations`).map((row) => row.version));
    const files = readdirSync(join(root, 'supabase', 'migrations')).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
    let count = 0;
    for (const file of files) {
      const [, versionId, name] = file.match(/^(\d+)_(.+)\.sql$/);
      if (applied.has(versionId)) continue;
      const text = readFileSync(join(root, 'supabase', 'migrations', file), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(text);
        await tx.unsafe('insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)', [versionId, name, [text]]);
      });
      console.log(`  applied ${file}`);
      count += 1;
    }
    console.log(count ? `  ${count} migration(s) applied.` : '  Database is up to date.');
  } catch (error) {
    fail(`Database migration failed: ${error.message}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** A private bucket for tracked PDFs. Existing bucket settings are never changed. */
async function ensureDocumentsBucket(env) {
  const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' };
  const base = env.SUPABASE_URL.replace(/\/+$/, '');
  const existing = await fetch(`${base}/storage/v1/bucket/${encodeURIComponent(env.DOCUMENTS_BUCKET)}`, { headers });
  if (existing.ok) {
    if ((await existing.json()).public) fail(`Storage bucket "${env.DOCUMENTS_BUCKET}" is public. Make it private in Supabase; tracked PDFs refuse public buckets.`);
    return;
  }
  const created = await fetch(`${base}/storage/v1/bucket`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: env.DOCUMENTS_BUCKET, name: env.DOCUMENTS_BUCKET, public: false, file_size_limit: Number(env.DOCUMENT_MAX_BYTES || 20_000_000), allowed_mime_types: ['application/pdf'] }),
  });
  if (!created.ok) fail(`Could not create the private Storage bucket "${env.DOCUMENTS_BUCKET}" (${created.status}).`);
  console.log(`  Created private Storage bucket "${env.DOCUMENTS_BUCKET}".`);
}

/**
 * Sign-in goes through Supabase Auth with Google. With SUPABASE_ACCESS_TOKEN set,
 * point Auth at this server and the extension; otherwise print the two settings.
 */
async function configureAuth(env, urls, extension) {
  const redirects = [`https://${extension}.chromiumapp.org/**`, `${urls.api}/**`];
  const ref = new URL(env.SUPABASE_URL).hostname.split('.')[0];
  if (!env.SUPABASE_ACCESS_TOKEN) {
    return [
      `Supabase → Authentication → URL Configuration: set Site URL to ${urls.api}/dashboard and add these Redirect URLs:\n       ${redirects.join('\n       ')}`,
      `Supabase → Authentication → Sign In / Providers → Google: enable it with your Google OAuth client (its redirect URI is ${env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/callback).`,
    ];
  }
  const endpoint = `https://api.supabase.com/v1/projects/${ref}/config/auth`;
  const headers = { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
  const current = await fetch(endpoint, { headers });
  if (!current.ok) fail(`Could not read the Supabase Auth settings (${current.status}). Check SUPABASE_ACCESS_TOKEN, or remove it to configure Auth by hand.`);
  const { uri_allow_list: list = '' } = await current.json();
  const allowList = [...new Set([...String(list).split(',').map((entry) => entry.trim()).filter(Boolean), ...redirects])].join(',');
  const update = { site_url: `${urls.api}/dashboard`, uri_allow_list: allowList };
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) Object.assign(update, { external_google_enabled: true, external_google_client_id: env.GOOGLE_CLIENT_ID, external_google_secret: env.GOOGLE_CLIENT_SECRET });
  const patched = await fetch(endpoint, { method: 'PATCH', headers, body: JSON.stringify(update) });
  if (!patched.ok) fail(`Could not update the Supabase Auth settings (${patched.status}).`);
  console.log('  Supabase Auth now redirects to this server and your extension.');
  return env.GOOGLE_CLIENT_ID ? [] : ['Supabase → Authentication → Sign In / Providers → Google: enable it (or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in server.env and deploy again).'];
}

// ---------------------------------------------------------------------------

async function main() {
  const env = loadServerEnv();
  const secrets = loadSecrets();
  const extension = extensionId(env);
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  const prefix = (env.WORKER_NAME_PREFIX || 'pigeonbox').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(prefix)) fail('WORKER_NAME_PREFIX may use lowercase letters, digits and hyphens.');
  const names = { api: `${prefix}-api`, tracker: `${prefix}-tracker`, queue: `${prefix}-tracking-events` };
  const commit = (await run('git', ['rev-parse', 'HEAD'], { capture: true })).output.trim().match(/^[a-f0-9]{40}$/)?.[0];

  if (!dryRun) {
    step('Checking your Cloudflare login');
    const { code, output } = await npx(['wrangler', 'whoami'], { capture: true });
    if (code !== 0 || /not authenticated/i.test(output)) fail('Log in to Cloudflare first: npx wrangler login');

    step('Migrating your Supabase database');
    await migrate(env.DATABASE_URL);
    if (env.DOCUMENTS_BUCKET) await ensureDocumentsBucket(env);

    if (env.TRACKER_QUEUE === 'true') {
      step('Creating the tracking event queues');
      for (const queue of [names.queue, `${names.queue}-dead`]) {
        const { output } = await npx(['wrangler', 'queues', 'list'], { capture: true });
        if (!output.includes(queue)) await npx(['wrangler', 'queues', 'create', queue]);
      }
    }
  }

  step('Building the shared packages the Workers bundle');
  const shared = ['packages/shared', 'packages/api-contract', 'packages/ai', 'packages/cloud-client', 'packages/tracking', 'workers/tracker'];
  if ((await npx(['tsc', '-b', ...shared])).code !== 0) fail('The TypeScript build failed. Fix the errors above and deploy again.');

  step(`${dryRun ? 'Bundling' : 'Deploying'} the tracker Worker (${names.tracker})`);
  const trackerUrl = env.TRACKER_URL ? httpsOrigin('TRACKER_URL', env.TRACKER_URL) : null;
  const deployedTracker = await deployWorker('tracker', trackerConfig(env, names, commit), trackerSecrets(env, secrets));
  const subdomain = deployedTracker?.match(/^https:\/\/[a-z0-9-]+\.([a-z0-9-]+)\.workers\.dev$/)?.[1] ?? state.subdomain ?? (dryRun ? 'your-subdomain' : null);
  if (!subdomain && !(env.API_URL && env.TRACKER_URL)) fail('Could not read your workers.dev address from wrangler. Set API_URL and TRACKER_URL in server.env and deploy again.');
  const urls = {
    api: env.API_URL ? httpsOrigin('API_URL', env.API_URL) : `https://${names.api}.${subdomain}.workers.dev`,
    tracker: trackerUrl ?? `https://${names.tracker}.${subdomain}.workers.dev`,
  };

  step(`${dryRun ? 'Bundling' : 'Deploying'} the API Worker (${names.api}) at ${urls.api}`);
  if ((await npm(['run', 'assets', '-w', '@pigeonbox/api-worker'])).code !== 0) fail('Copying the PDF viewer assets failed.');
  await deployWorker('api', apiConfig(env, names, urls, extension, commit), apiSecrets(env, secrets));

  if (dryRun) {
    console.log(`\nDry run finished. Generated Worker configs and bundles are in ${wranglerDir}. Nothing was deployed.`);
    return;
  }

  step('Configuring sign-in');
  const manual = await configureAuth(env, urls, extension);

  writePrivate(statePath, `${JSON.stringify({ apiUrl: urls.api, trackerUrl: urls.tracker, extensionId: extension, subdomain, commit: commit ?? null, version, deployedAt: new Date().toISOString() }, null, 2)}\n`);

  step('Pointing your extension build at this server');
  setExtensionEnv({ VITE_PIGEONBOX_CLOUD_API_URL: urls.api, VITE_PIGEONBOX_CLOUD_TRACKER_URL: urls.tracker });
  if ((await npm(['run', 'build'])).code !== 0) fail('The extension build failed. Fix the error above, then run `npm run build`.');

  step('Checking the deployment');
  await npx(['tsx', 'scripts/server/smoke.mjs']);

  const alwaysOn = PUBSUB.every((key) => env[key]);
  console.log(`
PigeonBox server is up.
  API and dashboard: ${urls.api}/dashboard
  Tracker:           ${urls.tracker}
  Extension ID:      ${extension}

Next:
  1. ${[...manual, 'Reload PigeonBox in chrome://extensions (Load unpacked → apps/extension/dist if it is not loaded yet).'].join('\n  - ')}
  2. Open Gmail, choose "Your PigeonBox server" in PigeonBox, and sign in with an address on ALLOWED_EMAILS.${alwaysOn ? '' : `
  3. Optional: always-on Gmail (background sync, prepared drafts, briefings) needs a Google Pub/Sub topic.
     See docs/self-hosting.md#always-on-gmail; add GOOGLE_PUBSUB_TOPIC and GOOGLE_PUBSUB_SERVICE_ACCOUNT to server.env and deploy again.`}
`);
}

await main();

/**
 * Rules for what may ship in the PigeonBox extension package, shared by
 * `npm run package` and `npm run verify`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Never packaged, even if present in the build output. */
export function isExcludedFromPackage(name) {
  const base = name.split('/').pop() ?? name;
  return (
    name.endsWith('.map') ||
    base === '.DS_Store' ||
    base === 'tracker-config.json' ||
    base.startsWith('.env') ||
    base === '.dev.vars' ||
    name.startsWith('node_modules/') ||
    name.includes('/node_modules/')
  );
}

export function collectFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else out.push({ name: relative(dir, full).split(sep).join('/'), data: readFileSync(full) });
    }
  };
  walk(dir);
  return out;
}

/** Patterns that look like credentials. Values are never printed, only file names. */
const SECRET_PATTERNS = [
  { label: 'OpenAI-style secret key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/ },
  { label: 'Stripe live secret', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/ },
  { label: 'Stripe test secret', re: /\b(?:sk|rk)_test_[A-Za-z0-9]{16,}/ },
  { label: 'Stripe webhook secret', re: /\bwhsec_[A-Za-z0-9]{16,}/ },
  { label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { label: 'Private key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: 'Supabase secret key', re: /\bsb_secret_[A-Za-z0-9_-]{16,}/ },
];

/** A JWT whose payload claims the Supabase service role. */
function containsServiceRoleJwt(text) {
  for (const match of text.matchAll(/eyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g)) {
    try {
      const payload = JSON.parse(Buffer.from(match[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      if (payload?.role === 'service_role') return true;
    } catch {
      /* not a JWT */
    }
  }
  return false;
}

export function findSecrets(name, data, forbiddenValues = [], allowed = new Set()) {
  const text = data.toString('utf8');
  const hits = [];
  for (const { label, re } of SECRET_PATTERNS) {
    const global = new RegExp(re.source, 'g');
    if ([...text.matchAll(global)].some((match) => !allowed.has(match[0]))) hits.push(`${name}: ${label}`);
  }
  if (containsServiceRoleJwt(text)) hits.push(`${name}: Supabase service-role JWT`);
  for (const { label, value } of forbiddenValues) {
    if (value && value.length >= 12 && text.includes(value)) hits.push(`${name}: value of ${label} from a local env file`);
  }
  return hits;
}

/**
 * Secret values from local env files, so a build can be checked for them
 * literally. Only values of variables that are secrets anywhere are read.
 */
export function localSecretValues(root) {
  const names = /^(PERSONAL_API_TOKEN|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_JWT_SECRET|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|CLOUD_AI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|CONVEX_DEPLOY_KEY|DEV_AUTH_SECRET|IP_HASH_SALT)$/;
  const files = ['.env', '.env.local', 'workers/tracker/.dev.vars', 'apps/extension/public/tracker-config.json'];
  const values = [];
  for (const file of files) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    if (file.endsWith('.json')) {
      try {
        const token = JSON.parse(text).personalApiToken;
        if (typeof token === 'string') values.push({ label: `personalApiToken (${file})`, value: token.trim() });
      } catch {
        /* ignore */
      }
      continue;
    }
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match || !names.test(match[1])) continue;
      const value = match[2].replace(/^['"]|['"]$/g, '').trim();
      if (value && !/generate-a-long-random-token|your-|YOUR_|replace-with/i.test(value)) values.push({ label: `${match[1]} (${file})`, value });
    }
  }
  return values;
}

/**
 * Public browser keys that third-party packages ship verbatim (InboxSDK embeds a
 * Google API key restricted to its own use). They are not PigeonBox secrets; any
 * key not found in the vendor package still fails the check.
 */
export function vendorPublicValues(root) {
  const values = new Set();
  const dir = join(root, 'node_modules', '@inboxsdk', 'core');
  if (!existsSync(dir)) return values;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.js')) continue;
    const text = readFileSync(join(dir, entry), 'utf8');
    for (const match of text.matchAll(/AIza[0-9A-Za-z_-]{35}/g)) values.add(match[0]);
  }
  return values;
}

const REQUIRED_FILES = [
  'manifest.json',
  'background.js',
  'gmail.js',
  'main-world.js',
  'offscreen.html',
  'workspace.html',
  'settings.html',
  'sidepanel.html',
  'onboarding.html',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'inboxsdk/pageWorld.js',
  'inboxsdk/background.js',
  'ort/ort-wasm-simd-threaded.asyncify.wasm',
  'ort/ort-wasm-simd-threaded.asyncify.mjs',
];

/**
 * Validate a set of packaged files. Returns a list of problems; empty means OK.
 * @param {Array<{name: string, data: Buffer}>} files
 */
export function validatePackage(files, { expectedVersion, forbiddenValues = [], allowedValues = new Set() } = {}) {
  const problems = [];
  const names = new Set(files.map((file) => file.name));
  for (const required of REQUIRED_FILES) if (!names.has(required)) problems.push(`missing ${required}`);
  for (const file of files) if (isExcludedFromPackage(file.name)) problems.push(`must not ship: ${file.name}`);
  for (const file of files) {
    if (/\.(ts|tsx)$/.test(file.name) && !file.name.endsWith('.d.ts')) problems.push(`source file in package: ${file.name}`);
    if (/\.test\.|\.spec\./.test(file.name)) problems.push(`test file in package: ${file.name}`);
    if (/\.(pem|key|sqlite|db)$/.test(file.name)) problems.push(`unexpected file type in package: ${file.name}`);
  }

  const manifestFile = files.find((file) => file.name === 'manifest.json');
  if (manifestFile) {
    let manifest;
    try {
      manifest = JSON.parse(manifestFile.data.toString('utf8'));
    } catch {
      problems.push('manifest.json is not valid JSON');
    }
    if (manifest) problems.push(...validateManifest(manifest, names, expectedVersion));
  }

  for (const file of files) {
    if (!/\.(js|mjs|html|json|css|txt)$/.test(file.name)) continue;
    problems.push(...findSecrets(file.name, file.data, forbiddenValues, allowedValues));
    if (file.name.endsWith('.html')) {
      const html = file.data.toString('utf8');
      for (const match of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
        if (/^(?:https?:)?\/\//i.test(match[1])) problems.push(`remote script in ${file.name}: ${match[1]}`);
      }
    }
  }
  return problems;
}

export function validateManifest(manifest, names, expectedVersion) {
  const problems = [];
  if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
  if (expectedVersion && manifest.version !== expectedVersion) problems.push(`manifest version ${manifest.version} != package version ${expectedVersion}`);
  if (!/^\d+(\.\d+){0,3}$/.test(String(manifest.version))) problems.push(`invalid manifest version ${manifest.version}`);
  // The store assigns the key; an uploaded manifest must not carry the dev build's.
  if ('key' in manifest) problems.push('manifest.json must not contain "key" (dev builds only)');
  const csp = manifest.content_security_policy?.extension_pages ?? '';
  // WebAssembly compilation ('wasm-unsafe-eval') is allowed; JS eval, inline script and remote sources are not.
  const stripped = csp.replace(/'wasm-unsafe-eval'/g, '');
  if (/'unsafe-eval'|'unsafe-inline'|https?:|(?:^|\s)\*/.test(stripped)) problems.push(`extension CSP allows remote or eval code: ${csp}`);
  const referenced = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.side_panel?.default_path,
    manifest.options_ui?.page,
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    ...(manifest.content_scripts ?? []).flatMap((script) => [...(script.js ?? []), ...(script.css ?? [])]),
  ].filter(Boolean);
  for (const path of referenced) if (!names.has(path)) problems.push(`manifest references missing file ${path}`);
  const hosts = manifest.host_permissions ?? [];
  const broad = hosts.filter((host) => /^(?:\*|<all_urls>|https?:\/\/\*\/\*|\*:\/\/\*\/\*)$/.test(host));
  if (broad.length) problems.push(`required host permissions are too broad: ${broad.join(', ')}`);
  return problems;
}

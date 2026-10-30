import { readFileSync } from 'node:fs';

/**
 * There is no official hosted PigeonBox server, so a release build (the GitHub
 * release ZIP and the store upload) ships with no server endpoints at all. People
 * who run their own server build from source with its URL in
 * apps/extension/.env.local, or set it in Settings → Advanced.
 */
export const RELEASE_CLOUD_ENV = Object.freeze({
  VITE_PIGEONBOX_CLOUD_API_URL: '',
  VITE_PIGEONBOX_CLOUD_TRACKER_URL: '',
  VITE_PIGEONBOX_CLOUD_TRACKER_PREVIOUS_URLS: '',
});

// A developer's shell or .env files must not change the uploaded product.
export function releaseBuildEnv(inherited, outDir) {
  return { ...inherited, ...RELEASE_CLOUD_ENV, PIGEONBOX_RELEASE: '1', PIGEONBOX_OUT_DIR: outDir, VITE_PIGEONBOX_EXPERIMENTAL: 'false' };
}

/** Source builds' local rebuild helper (apps/extension/vite.config.ts). It must never reach a release. */
const DEV_REBUILD_URL = 'http://127.0.0.1:5199';
/** A local PigeonBox server's API and tracker (development ports). */
const DEV_SERVER_URLS = ['127.0.0.1', 'localhost'].flatMap((host) => [`http://${host}:8788`, `http://${host}:8789`]);
/** Build-time server endpoints. None of their values may appear in a release. */
const SERVER_ENV = /^VITE_PIGEONBOX_CLOUD_[A-Z_]+$/;
/** The extension's .env files Vite reads, from apps/extension. */
const EXTENSION_ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'].map(
  (name) => new URL(`../../apps/extension/${name}`, import.meta.url),
);

function parseEnvFile(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

/**
 * Every server URL this machine could build with: `VITE_PIGEONBOX_CLOUD_*`
 * values from the shell and from apps/extension's .env files, split on commas.
 */
export function configuredServerEndpoints(env = process.env, files = EXTENSION_ENV_FILES) {
  const sources = [env];
  for (const file of files) {
    try {
      sources.push(parseEnvFile(readFileSync(file, 'utf8')));
    } catch {
      // No such file.
    }
  }
  const endpoints = new Set();
  for (const source of sources) {
    for (const [name, raw] of Object.entries(source)) {
      if (!SERVER_ENV.test(name) || typeof raw !== 'string') continue;
      for (const value of raw.split(',').map((part) => part.trim().replace(/\/+$/, '')).filter(Boolean)) endpoints.add(value);
    }
  }
  return [...endpoints];
}

/**
 * A release must carry no PigeonBox server endpoint and no development URL.
 * Rejects output built with a developer's server URL (passed via --skip-build,
 * or a build that ignored the release environment) and source-build output.
 */
export function validateReleaseConfig(files, endpoints = configuredServerEndpoints()) {
  const text = files
    .filter((file) => /\.(js|mjs|json|html)$/.test(file.name))
    .map((file) => file.data.toString('utf8'))
    .join('\n');
  const problems = endpoints
    .filter((endpoint) => text.includes(endpoint))
    .map((endpoint) => `release contains the PigeonBox server endpoint ${endpoint} (release builds ship without a server)`);
  if (text.includes(DEV_REBUILD_URL)) problems.push('release contains the development rebuild helper URL (not a release build)');
  for (const url of DEV_SERVER_URLS) if (!endpoints.includes(url) && text.includes(url)) problems.push(`release contains the development server URL ${url}`);
  return problems;
}

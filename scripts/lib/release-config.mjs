/** Public production endpoints for the single Local + Cloud extension release. */
export const RELEASE_CLOUD_ENV = Object.freeze({
  VITE_PIGEONBOX_CLOUD_API_URL: 'https://pigeonbox-cloud-api.pigeonbox.workers.dev',
  VITE_PIGEONBOX_CLOUD_TRACKER_URL: 'https://pigeonbox-cloud-tracker.pigeonbox.workers.dev',
  VITE_PIGEONBOX_CLOUD_TRACKER_PREVIOUS_URLS: '',
});

// A developer's shell or .env files must not change the uploaded product.
export function releaseBuildEnv(inherited, outDir) {
  return { ...inherited, ...RELEASE_CLOUD_ENV, PIGEONBOX_RELEASE: '1', PIGEONBOX_OUT_DIR: outDir, VITE_PIGEONBOX_EXPERIMENTAL: 'false' };
}

/** Hosts a release build may point Cloud at. A new production domain is added here on purpose, never by accident. */
const PRODUCTION_HOSTS = [/^[a-z0-9-]+\.pigeonbox\.workers\.dev$/, /^(?:[a-z0-9-]+\.)?usepigeonbox\.com$/];
/** Source builds' local rebuild helper (apps/extension/vite.config.ts). It must never reach a release. */
const DEV_REBUILD_URL = 'http://127.0.0.1:5199';

/** Production endpoints are HTTPS origins on a PigeonBox production host: no loopback, ports, paths or credentials. */
export function validateReleaseEndpoints(env = RELEASE_CLOUD_ENV) {
  const problems = [];
  for (const [name, raw] of Object.entries(env)) {
    for (const value of raw.split(',').map((part) => part.trim()).filter(Boolean)) {
      let url;
      try {
        url = new URL(value);
      } catch {
        problems.push(`${name} is not a URL: ${value}`);
        continue;
      }
      if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
        problems.push(`${name} must be a plain https origin: ${value}`);
      } else if (!PRODUCTION_HOSTS.some((host) => host.test(url.hostname))) {
        problems.push(`${name} is not a PigeonBox production host: ${url.hostname}`);
      }
    }
  }
  return problems;
}

/** Also reject old Local-only output passed via --skip-build, and source-build output. */
export function validateReleaseConfig(files) {
  const scripts = files.filter((file) => /\.(js|mjs)$/.test(file.name)).map((file) => file.data.toString('utf8')).join('\n');
  const problems = Object.entries(RELEASE_CLOUD_ENV)
    .filter(([, value]) => value && !scripts.includes(value))
    .map(([name]) => `release is missing the production endpoint for ${name}`);
  if (scripts.includes(DEV_REBUILD_URL)) problems.push('release contains the development rebuild helper URL (not a release build)');
  return [...problems, ...validateReleaseEndpoints()];
}

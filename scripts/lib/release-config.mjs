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

/** Also reject old Local-only output passed via --skip-build. */
export function validateReleaseConfig(files) {
  const scripts = files.filter((file) => /\.(js|mjs)$/.test(file.name)).map((file) => file.data.toString('utf8')).join('\n');
  return Object.entries(RELEASE_CLOUD_ENV)
    .filter(([, value]) => value && !scripts.includes(value))
    .map(([name]) => `release is missing the production endpoint for ${name}`);
}

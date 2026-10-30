import { spawnSync } from 'node:child_process';
const required = ['CLOUD_AI_PROVIDER', 'CLOUD_AI_BASE_URL', 'CLOUD_AI_API_KEY', 'CLOUD_AI_PRIMARY_MODEL'];
const missing = required.filter(key => !process.env[key]);
if (missing.length || process.env.CLOUD_AI_PROVIDER === 'mock') {
  console.error(`BLOCKED live eval: supply real provider settings (${missing.join(', ') || 'CLOUD_AI_PROVIDER must not be mock'}). Worker secrets cannot be downloaded.`);
  process.exitCode = 2;
} else {
  const run = spawnSync('npx', ['vitest', 'run', 'packages/server/src/evals'], { stdio: 'inherit', env: { ...process.env, PIGEONBOX_EVAL_LIVE: '1' } });
  process.exitCode = run.status ?? 1;
}

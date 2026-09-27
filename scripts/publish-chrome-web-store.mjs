#!/usr/bin/env node
/**
 * Uploads a release ZIP to the existing PigeonBox Chrome Web Store item and
 * submits it for review (Chrome Web Store API v2). The release workflow runs
 * this after the GitHub release, so both carry the same ZIP.
 *
 *   node scripts/publish-chrome-web-store.mjs release/PigeonBox-v0.3.1.zip
 *
 * Needs CWS_PUBLISHER_ID and CWS_EXTENSION_ID, plus credentials: either
 * CWS_SERVICE_ACCOUNT_JSON (a service account key; preferred, it does not
 * expire) or CWS_CLIENT_ID, CWS_CLIENT_SECRET and CWS_REFRESH_TOKEN.
 * Setup: docs/chrome-web-store.md.
 * CWS_PUBLISH=false uploads a draft without submitting it.
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';

const API = 'https://chromewebstore.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

async function call(url, init, what) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) throw new Error(`${what} failed (${response.status}): ${text.slice(0, 800)}`);
  return body;
}

async function accessToken() {
  const serviceAccount = process.env.CWS_SERVICE_ACCOUNT_JSON?.trim();
  const form = serviceAccount
    ? { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountJwt(JSON.parse(serviceAccount)) }
    : {
        client_id: required('CWS_CLIENT_ID'),
        client_secret: required('CWS_CLIENT_SECRET'),
        refresh_token: required('CWS_REFRESH_TOKEN'),
        grant_type: 'refresh_token',
      };
  const body = await call(
    TOKEN_URL,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) },
    'Getting an access token',
  );
  if (!body.access_token) throw new Error('Google returned no access token.');
  return body.access_token;
}

/** A signed JWT the token endpoint exchanges for an access token (RFC 7523). */
function serviceAccountJwt(key) {
  if (!key.client_email || !key.private_key) throw new Error('CWS_SERVICE_ACCOUNT_JSON is not a service account key.');
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url');
  return `${unsigned}.${signature}`;
}

/** The API has named this field both ways; read whichever is present. */
function uploadState(body) {
  return String(body.uploadState || body.lastAsyncUploadState || '');
}

async function main() {
  const zipPath = process.argv[2];
  if (!zipPath) throw new Error('Usage: publish-chrome-web-store.mjs <release zip>');
  const item = `publishers/${required('CWS_PUBLISHER_ID')}/items/${required('CWS_EXTENSION_ID')}`;
  const zip = readFileSync(zipPath);
  const token = await accessToken();
  const auth = { Authorization: `Bearer ${token}` };

  console.log(`Uploading ${zipPath} (${(zip.length / 1e6).toFixed(1)} MB) to ${item}…`);
  let status = await call(
    `${API}/upload/v2/${item}:upload?uploadType=media`,
    { method: 'POST', headers: { ...auth, 'Content-Type': 'application/zip' }, body: zip },
    'Upload',
  );
  for (let attempt = 0; /IN_PROGRESS/.test(uploadState(status)) && attempt < 30; attempt += 1) {
    await wait(10_000);
    status = await call(`${API}/v2/${item}:fetchStatus`, { headers: auth }, 'Checking upload status');
  }
  const state = uploadState(status);
  if (!/SUCCEEDED/.test(state)) throw new Error(`Upload did not succeed (state ${state || 'unknown'}): ${JSON.stringify(status).slice(0, 800)}`);
  console.log(`Uploaded version ${status.crxVersion || '(pending)'}.`);

  if (process.env.CWS_PUBLISH === 'false') {
    console.log('CWS_PUBLISH=false: left as a draft. Submit it from the developer dashboard.');
    return;
  }
  const published = await call(
    `${API}/v2/${item}:publish`,
    { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }) },
    'Submitting for review',
  );
  console.log(`Submitted for review: ${published.state || 'ok'}.`);
  if (published.warningInfo) console.log(`Warnings: ${JSON.stringify(published.warningInfo)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

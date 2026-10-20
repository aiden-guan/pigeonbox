#!/usr/bin/env node
/** Capture the compiled extension with synthetic data in disposable profiles. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const input = args.indexOf('--extension');
if (input < 0 || !args[input + 1]) throw new Error('Usage: node scripts/capture-readme.mjs --extension <isolated build directory>');
const extension = realpathSync(resolve(args[input + 1]));
const workingBuild = join(root, 'apps/extension/dist');
if (existsSync(workingBuild) && extension === realpathSync(workingBuild)) {
  throw new Error('Build into a separate PIGEONBOX_OUT_DIR first; captures must not modify the working Chrome build.');
}
if (!existsSync(join(extension, 'manifest.json'))) throw new Error('Build the extension before capturing.');
const output = join(root, 'assets/readme');
mkdirSync(output, { recursive: true });
mkdirSync(join(root, 'tmp'), { recursive: true });
const temporary = mkdtempSync(join(root, 'tmp/readme-capture-'));
const environment = { ...process.env, PIGEONBOX_BROWSER_EXTENSION_PATH: extension, PIGEONBOX_README_CAPTURE: '1' };
function run(command, argv, env = environment) {
  const result = spawnSync(command, argv, { cwd: root, env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Capture command failed: ${command} (exit ${result.status})`);
}

try {
  // All generated fixture entries go into the explicit isolated build.
  run(process.execPath, ['scripts/build-browser-fixture.mjs']);
  writeFileSync(join(temporary, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(temporary, 'playwright.config.cjs'), `module.exports = {
    testDir: '.', timeout: 90000, workers: 1, retries: 0, reporter: 'list',
    outputDir: ${JSON.stringify(join(temporary, 'results'))}
  };\n`);
  writeFileSync(join(temporary, 'readme.spec.ts'), `
import { test, expect } from ${JSON.stringify(join(root, 'tests/browser/fixtures'))};
import { ownerPerspectiveKey } from ${JSON.stringify(join(root, 'packages/shared/src/owner'))};

test('capture the real extension UI with explicitly synthetic mail', async ({ app }) => {
  async function capture(page, name, width = 480, height = 640) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: ${JSON.stringify(output)} + '/' + name, animations: 'disabled' });
  }

  const local = await app.page('workspace');
  await local.evaluate(async (perspective) => {
    await chrome.runtime.sendMessage({ type: 'LIST_SPLIT', category: 'RESPOND' });
    await chrome.storage.local.set({ mailboxIdentities: { '0': { email: 'owner@fixture.test', name: 'Owner' } } });
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('gi_mailbox_v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['threads', 'thread_summaries', 'search_documents'], 'readwrite');
    const subjects = ['Final review on the launch note', 'Budget for the next sprint', 'Thursday workshop notes'];
    const names = ['Maya Chen', 'Priya Shah', 'Northwind team'];
    for (let i = 0; i < subjects.length; i++) {
      const id = 'abc' + i;
      const at = '2026-10-01T16:42:00.000Z';
      tx.objectStore('threads').put({ threadId: id, accountId: 'fixture', mailboxEmail: 'owner@fixture.test', subject: subjects[i], participants: [], latestSender: { name: names[i], email: 'sender@fixture.test' }, latestTimestamp: at, messageCount: 2, snippet: 'Review requested before Friday.', route: 'inbox', lastIndexedAt: Date.now(), contentFingerprint: id, classification: 'RESPOND', priority: i === 0 ? 'HIGH' : 'NORMAL', archivedLocally: false, requiresResponse: true, awaitingResponse: false, virtualLabels: [] });
      tx.objectStore('thread_summaries').put({ threadId: id, fingerprint: id, sourceFingerprint: id, ownerPerspective: perspective, source: 'model', aiStatus: 'success', createdAt: Date.now(), summary: { oneLine: 'Two edits are needed before Friday’s 10:00 review.', keyPoints: ['Final launch review'], actionItems: ['Soften the opening', 'Replace the screenshot'], dates: ['Friday · 10:00 AM'], decisions: [], unansweredQuestions: [], commitments: [] } });
      tx.objectStore('search_documents').put({ id, threadId: id, text: subjects[i] + ' Maya review Friday launch', subject: subjects[i], senders: names[i], recipients: 'owner@fixture.test', labels: 'RESPOND', timestamp: at, fingerprint: id });
    }
    await new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
  }, ownerPerspectiveKey({ email: 'owner@fixture.test', name: 'Owner' }));
  await local.reload();
  await expect(local.getByRole('button', { name: 'Read brief: Final review on the launch note' })).toBeVisible();
  await capture(local, 'feature-triage.png');
  await local.getByRole('button', { name: 'Read brief: Final review on the launch note' }).click();
  await expect(local.getByRole('region', { name: 'Pidgy Brief' })).toContainText('Two edits');
  await capture(local, 'feature-companion.png');

  const cloud = await app.page('workspace', true);
  await expect(cloud.getByRole('heading', { name: 'Needs you' })).toBeVisible();
  await capture(cloud, 'hero.png', 960, 540);
  await cloud.locator('[data-command-launcher]').click();
  await cloud.getByRole('combobox').fill('Prepared drafts');
  await cloud.getByRole('combobox').press('Enter');
  await cloud.getByRole('button', { name: 'Review draft: Pricing' }).click();
  await expect(cloud.getByText('Prepared in PigeonBox. Not in Gmail yet.')).toBeVisible();
  await capture(cloud, 'feature-drafting.png');

  await cloud.getByRole('button', { name: 'Chat', exact: true }).click();
  await cloud.getByRole('textbox', { name: 'Message Pigeon', exact: true }).fill('Who needs pricing?');
  await cloud.locator('form').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(cloud.getByText('Maya needs pricing.', { exact: true })).toBeVisible();
  await capture(cloud, 'feature-ask.png');
});
`);
  run(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', join(temporary, 'playwright.config.cjs')]);
  for (const name of ['hero.png', 'feature-triage.png', 'feature-companion.png', 'feature-drafting.png', 'feature-ask.png']) {
    const png = readFileSync(join(output, name));
    const [width, height] = name === 'hero.png' ? [1920, 1080] : [960, 1280];
    if (png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) {
      throw new Error(`${name} did not capture at the required 2× device scale.`);
    }
  }
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'));
  writeFileSync(join(output, 'capture.json'), JSON.stringify({
    capturedAt: new Date().toISOString(),
    sourceCommit: revision.stdout.trim(),
    extensionVersion: manifest.version,
    runtime: 'Compiled extension in disposable Chromium profile',
    data: 'Synthetic IndexedDB mail, summaries, Cloud session, API responses and prepared text; no live Gmail or model inference',
    deviceScaleFactor: 2,
    heroViewport: { width: 960, height: 540 },
    featureViewport: { width: 480, height: 640 },
    files: ['hero.png', 'feature-triage.png', 'feature-companion.png', 'feature-drafting.png', 'feature-ask.png'],
  }, null, 2) + '\n');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

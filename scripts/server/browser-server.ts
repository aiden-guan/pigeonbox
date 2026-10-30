/** Loopback-only UI fixture server over the existing real router/PGlite/FakeGoogle harness. */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Automation } from '@pigeonbox/api-contract';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Workspace packages load from source, as in vitest.config.ts, so the fixture
// never runs against a stale or missing dist build.
registerHooks({
  resolve(specifier, context, next) {
    const name = /^@pigeonbox\/([a-z-]+)$/.exec(specifier)?.[1];
    const source = name && resolve(root, name === 'tracker' ? 'workers/tracker/src/index.ts' : `packages/${name}/src/index.ts`);
    if (source && existsSync(source)) return { url: pathToFileURL(source).href, shortCircuit: true };
    return next(specifier, context);
  },
});

async function main() {
  const port = Number(process.env.PIGEONBOX_BROWSER_PORT ?? 8790);
  const origin = `http://127.0.0.1:${port}`;
  const { PromiseFixtureAI } = await import('../../packages/server/src/testing/memory-fixtures.js');
  const { createIntelHarness, connectedUser, deliverAndSync } = await import('../../packages/server/src/testing/intel-harness.js');
  const h = await createIntelHarness({ inference: new PromiseFixtureAI(), env: { API_BASE_URL: origin, PUBLIC_APP_URL: origin, ALLOWED_WEB_ORIGINS: origin } });
  const owner = 'ada@work.test';
  const user = await connectedUser(h, owner, ['mail_read', 'drafts', 'organize', 'send']);
  const intro = await deliverAndSync(h, owner, { from: owner, to: ['lee@client.test'], subject: 'Browser approval fixture', body: 'Lee, meet Maya. Please review the pilot.' });
  const { draft } = await h.route<{ draft: Omit<Automation, 'id'> }>('automationCompile', user.token, { prompt: 'When Lee replies, send a thank-you note' });
  const { automation } = await h.route<{ automation: Automation }>('automationSave', user.token, { ...draft, prompt: 'When Lee replies, send a thank-you note', mode: 'shadow' });
  await h.route('automationSave', user.token, { ...automation, mode: 'active', enabled: true });
  await deliverAndSync(h, owner, { from: 'lee@client.test', to: [owner], threadId: intro.threadId, subject: 'Re: Browser approval fixture', body: 'Thanks for the intro, happy to chat next week.' });
  await deliverAndSync(h, owner, { from: 'maya@client.test', to: [owner], subject: 'Browser Focus fixture', body: 'Could you send the slides before Friday?' });
  await deliverAndSync(h,owner,{ from: 'professor@berkeley.test',to: [owner],subject: 'Midterm 2 Logistics',body: 'Midterm 2 covers through Chapter 8. Calculators are not allowed.' });
  // The owner tells several people the same things; Memory keeps one page about them.
  await deliverAndSync(h, owner, { from: owner, to: ['recruiter@multifactor.test'], subject: 'Summer internship', body: "I'm a freshman at UC Berkeley studying business and data science." });
  await deliverAndSync(h, owner, { from: owner, to: ['sam@friends.test'], subject: 'Catching up', body: "I'm a freshman at UC Berkeley studying business and data science." });
  await deliverAndSync(h, owner, { from: owner, to: ['recruiter@multifactor.test'], subject: 'Re: Summer internship', body: 'I want to work at Multifactor this summer.' });
  await deliverAndSync(h, owner, { from: owner, to: ['lee@client.test'], subject: 'Side project', body: 'I built PigeonBox, an AI email copilot.' });
  // An actual synced promise, unrelated PDF, and later matching delivery.
  const promisedAt = new Date(h.now().getTime() - 2 * 86_400_000);
  await deliverAndSync(h, owner, { from: 'bangee@client.test', fromName: 'Bangee K Lee', to: [owner], subject: 'Proposal', body: 'Can you send the proposal?', at: new Date(promisedAt.getTime() - 3_600_000) });
  await deliverAndSync(h, owner, { from: owner, to: ['bangee@client.test'], subject: 'Proposal promise', body: "I'll send the proposal PDF tomorrow.", at: promisedAt });
  await deliverAndSync(h, owner, { from: owner, to: ['bangee@client.test'], subject: 'Budget promise', body: "I'll send the budget spreadsheet.", at: promisedAt });
  await deliverAndSync(h, owner, { from: owner, to: ['bangee@client.test'], subject: 'Travel receipt', body: 'Here is a receipt.', at: new Date(promisedAt.getTime() + 3_600_000), attachments: [{ filename: 'receipt.pdf', mimeType: 'application/pdf', size: 400 }] });
  await deliverAndSync(h, owner, { from: owner, to: ['bangee@client.test'], subject: 'Your proposal', body: 'Here is the proposal we discussed, attached.', at: new Date(promisedAt.getTime() + 7_200_000), attachments: [{ filename: 'proposal.pdf', mimeType: 'application/pdf', size: 500 }] });
  // Mailing lists: one-click, link-only and mailto unsubscribes. The fake list servers accept every one-click POST.
  h.google.external = () => new Response('ok', { status: 200 });
  const oneClick = { 'List-Unsubscribe': '<https://lists.shop.test/u/abc>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
  for (const subject of ['Fall sale starts now', '48 hours left', 'New arrivals']) await deliverAndSync(h, owner, { from: 'news@shop.test', fromName: 'Shop News', to: [owner], subject, body: 'Big sale', headers: oneClick });
  for (const subject of ['Your weekly digest', 'Top stories']) await deliverAndSync(h, owner, { from: 'digest@medium.test', fromName: 'Medium Daily Digest', to: [owner], subject, body: 'Stories', headers: { 'List-Unsubscribe': '<https://medium.test/settings/email>' } });
  await deliverAndSync(h, owner, { from: 'club@running.test', fromName: 'Running Club', to: [owner], subject: 'Saturday run', body: 'See you there', headers: { 'List-Unsubscribe': '<mailto:leave@running.test?subject=unsubscribe>' } });
  // Run the debounced consolidation pass so pages open with their overview.
  await h.route('memorySubjects', user.token, {});
  await h.drain();
  // One hosted-tracking record with protocol-counted opens and a click, for the Engagement tab.
  await h.sql(
    `insert into public.tracked_emails (tracking_id, user_id, status, subject, sender, recipients, sent_at, open_count, first_opened_at, last_opened_at, click_count)
     values ('trk_browser_fixture', $1, 'SENT', 'Browser tracking fixture', $2, '["lee@client.test"]'::jsonb, now() - interval '2 days', 2, now() - interval '2 days' + interval '15 minutes', now() - interval '1 day', 1)`,
    [user.userId, owner],
  );
  const assets = resolve(root, 'apps/web/public');
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json' };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', origin);
      if (url.pathname === '/__fixture/health') { res.end('ready'); return; }
      if (url.pathname === '/__fixture/stats') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ sent: h.google.account(owner).sent.length })); return; }
      if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/d/')) {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const response = await h.api(new Request(url, { method: req.method, headers: req.headers as Record<string, string>, ...(body.length ? { body } : {}) }));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      const relative = decodeURIComponent(url.pathname).replace(/^\//, '') || 'dashboard.html';
      const path = resolve(assets, extname(relative) ? relative : `${relative}.html`);
      if (!path.startsWith(`${assets}/`)) { res.writeHead(403); res.end(); return; }
      res.setHeader('Content-Type', types[extname(path)] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      // Manual checks of extension-backed pages: the `fake-ext=1` cookie loads the stand-in extension first.
      if (path.endsWith('dashboard.html') && /(?:^|;\s*)fake-ext=1/.test(req.headers.cookie ?? '')) {
        const stub = await readFile(resolve(root, 'tests/server/fake-extension.js'), 'utf8');
        res.end((await readFile(path, 'utf8')).replace('<head>', `<head><script>${stub}</script>`));
        return;
      }
      res.end(await readFile(path));
    } catch (error) {
      // Like the Worker's `not_found_handling = "404-page"`.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !res.headersSent) {
        res.writeHead(404, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        res.end(await readFile(resolve(assets, '404.html')).catch(() => 'Not found'));
        return;
      }
      if (!res.headersSent) res.writeHead(500);
      res.end('Fixture server error');
    }
  });
  server.listen(port, '127.0.0.1', () => console.log(`Browser fixture ready at ${origin}`));
  const stop = () => server.close(() => { void h.pg.close().then(() => process.exit(0)); });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
void main();

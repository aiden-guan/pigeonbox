// Renders the Chrome Web Store graphics in docs/store/.
//
//   node docs/store/src/render.mjs [--capture] [name ...]
//
// Pages in this folder use the website's halftone renderer, brand atlases and
// paper grain, so the website checkout must sit next to this one (or set
// PIGEONBOX_SITE). --capture first refreshes ui/*.png from the website's Gmail
// walkthrough, which is built from the real extension components with
// fictional mail. Output is opaque 24-bit PNG, as the store requires.
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const src = dirname(fileURLToPath(import.meta.url));
const repo = resolve(src, '../../..');
const site = resolve(process.env.PIGEONBOX_SITE || resolve(repo, '../PigeonBoxSite/pigeonboxsite'));
const out = resolve(src, '..');
const { chromium } = createRequire(resolve(repo, 'package.json'))('@playwright/test');

export const PAGES = {
  'screenshot-1': [1280, 800], 'screenshot-2': [1280, 800], 'screenshot-3': [1280, 800],
  'screenshot-4': [1280, 800], 'screenshot-5': [1280, 800],
  'promo-small': [440, 280], 'promo-marquee': [1400, 560],
};
// Walkthrough moments (ms into its 21 s timeline) used by the screenshots.
const MOMENTS = { inbox: 500, brief: 2300, summary: 4700, compose: 7300, typing: 10300, answer: 15200 };

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.startsWith('/store/') ? resolve(src, '.' + path.slice(6)) : resolve(site, '.' + path);
  if (!file.startsWith(src) && !file.startsWith(site)) { res.writeHead(403); res.end(); return; }
  try { await stat(file); res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream'); res.end(await readFile(file)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const args = process.argv.slice(2);

try {
  if (args.includes('--capture')) await capture();
  const names = args.filter((a) => !a.startsWith('--'));
  for (const name of names.length ? names : Object.keys(PAGES)) {
    const [width, height] = PAGES[name];
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => console.error(name, e.message));
    await page.goto(`${origin}/store/${name}.html`);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
    await page.waitForTimeout(400);
    const file = resolve(out, `${name}.png`);
    await page.screenshot({ path: file });
    await page.close();
    // Flatten to RGB: the store rejects PNGs with an alpha channel.
    execFileSync('python3', ['-c', 'import sys;from PIL import Image;Image.open(sys.argv[1]).convert("RGB").save(sys.argv[1],optimize=True)', file]);
    console.log(`${name}.png ${width}×${height}`);
  }
} finally {
  await browser.close();
  server.close();
}

async function capture() {
  await writeFile(resolve(src, 'ui/.harness.html'), `<!doctype html><body style="margin:0"><iframe id="f" src="/assets/gmail-demo/index.html" width="1100" height="760" style="border:0;display:block"></iframe><script>
const f=document.getElementById('f');window.ctl=(paused)=>f.contentWindow.postMessage({type:'pb-demo-control',paused,visible:true},location.origin);
addEventListener('message',e=>{if(e.data?.type==='pb-demo-ready')window.ready=true});</script>`);
  for (const [name, at] of Object.entries(MOMENTS)) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    await page.goto(`${origin}/store/ui/.harness.html`);
    await page.waitForFunction(() => window.ready);
    const frame = page.frames().find((f) => f.url().includes('gmail-demo/index.html'));
    await frame.addStyleTag({ content: '.gm-cursor{display:none!important}' });
    await page.evaluate(() => ctl(false));
    await frame.waitForFunction((t) => +document.querySelector('.gm-recording').dataset.time >= t, at, { timeout: 30000, polling: 16 });
    await page.evaluate(() => ctl(true));
    await page.waitForTimeout(700);
    await page.screenshot({ path: resolve(src, `ui/${name}-full.png`) });
    await (await frame.$('.gm-sidepanel')).screenshot({ path: resolve(src, `ui/${name}-panel.png`) });
    await page.close();
    console.log(`ui/${name} captured at ${at} ms`);
  }
}

// Captures real PigeonBox UI from the extension's Copper Perch preview fixture
// (apps/extension/src/preview) at 2x via the Chrome DevTools protocol.
// Usage: node scripts/capture-product.mjs <chrome-binary> [baseUrl]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chrome = process.argv[2];
const base = process.argv[3] || 'http://localhost:5178';
const out = new URL('../public/product/', import.meta.url).pathname;
const port = 9333;
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'pbcap-'))}`, 'about:blank'],
  { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); }
  catch { await sleep(200); }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.result.value;

async function open(path, w = 1440, h = 1800) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: base + path });
  await sleep(2500);
}
async function shot(name, selector, pad = 0, index = 0) {
  const r = await evalJs(`(()=>{const e=document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if(!e) return null; const b=e.getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height};})()`);
  if (!r) { console.log('missing', selector); return; }
  const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
    clip: { x: r.x - pad, y: r.y - pad, width: r.w + pad * 2, height: r.h + pad * 2, scale: 1 } });
  writeFileSync(join(out, name + '.png'), Buffer.from(res.result.data, 'base64'));
  console.log(name, Math.round(r.w), Math.round(r.h));
}

await send('Page.enable'); await send('Runtime.enable');

// The preview fixture ships fictional demo mail. Swap its demo copy for the film's story
// (walks text nodes only; the UI itself is untouched).
const STORY = [
  ['Maya likes the direction. She needs two small changes before Friday’s review.', 'Oliver’s samples arrive tomorrow morning. He needs the delivery address confirmed.'],
  ['Friday, September 25', 'Tomorrow, 9:00 AM'],
  ['Try a warmer tone for the main screen.', 'Three swatches, including the copper finish.'],
  ['Keep the pigeon. Give it a little personality.', 'The courier needs a signature.'],
  ['Send the updated screens before the review.', 'Confirm the delivery address.'],
  ['Maya is waiting for feedback on the new direction. Oliver’s samples arrive tomorrow. Nina and Alex suggested coffee on Tuesday.',
   'Nina and Alex asked about coffee on Tuesday at 10. Jordan is waiting on the boards for Friday.'],
];
const storyfy = (rootExpr) => evalJs(`(()=>{const pairs=${JSON.stringify(STORY)};const root=${rootExpr};if(!root)return 0;const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n,c=0;while((n=w.nextNode())){for(const [a,b] of pairs){if(n.nodeValue.includes(a)){n.nodeValue=n.nodeValue.replace(a,b);c++;}}}return c;})()`);
const THREAD = `document.querySelector('[data-gi-ui="thread-sidebar"]').shadowRoot`;
const PANEL = `document.querySelector('.preview-panel')`;
await open('/src/preview/index.html');
await shot('popup', '.preview-grid article > :not(.preview-caption)', 0, 0);
await shot('sidepanel', '.preview-panel', 0, 0);
await storyfy(THREAD);
await shot('thread', '[data-gi-ui="thread-sidebar"]', 0, 0);
await shot('overview', '.preview', 0, 0);
// Thread companion mid-draft: click "Draft reply" inside the shadow root, catch the drafting state.
await evalJs(`[...document.querySelector('[data-gi-ui="thread-sidebar"]').shadowRoot.querySelectorAll('button')].find(b=>b.textContent.includes('Draft reply')).click()`);
await sleep(700);
await storyfy(THREAD);
await shot('thread-drafting', '[data-gi-ui="thread-sidebar"]', 0, 0);
await sleep(2500);
// Ask your inbox: empty state, asking, answered.
await evalJs(`[...document.querySelectorAll('.preview-panel button')].find(b=>b.textContent.trim()==='Ask').click()`);
await sleep(600);
const hideFixtureNotes = `[...document.querySelectorAll('.preview-panel p, .preview-panel div')].filter(e=>e.children.length===0 && /Preview uses fictional|AI is off/.test(e.textContent)).forEach(e=>e.style.display='none')`;
await evalJs(hideFixtureNotes);
await shot('ask-empty', '.preview-panel', 0, 0);
await evalJs(`[...document.querySelectorAll('.preview-panel button')].find(b=>b.textContent.startsWith('What needs a reply?')).click()`);
await sleep(300);
await shot('ask-typed', '.preview-panel', 0, 0);
await evalJs(`document.querySelector('.preview-panel form').requestSubmit()`);
await sleep(500);
await evalJs(hideFixtureNotes);
await shot('ask-loading', '.preview-panel', 0, 0);
await sleep(2400);
// Hide the fixture's own disclaimers (not shown in the shipped extension).
await evalJs(hideFixtureNotes);
await storyfy(PANEL);
await sleep(200);
await shot('ask', '.preview-panel', 0, 0);
// Onboarding and settings screens.
await evalJs(`[...document.querySelectorAll('.preview-nav button')].find(b=>b.textContent==='onboarding').click()`);
await sleep(1200);
await shot('onboarding', '.preview > :not(header)', 0, 0);
await evalJs(`[...document.querySelectorAll('.preview-nav button')].find(b=>b.textContent==='settings').click()`);
await sleep(1200);
await shot('settings', '.preview > :not(header)', 0, 0);
ws.close(); proc.kill();

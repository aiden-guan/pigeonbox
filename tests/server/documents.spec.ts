import { expect, test, type Page } from './fixtures';
import { testPdf } from '../../packages/server/src/testing/pdf.js';

// The full Chromium browser includes its native PDF viewer; headless shell does not.
test.use({ channel: 'chromium' });

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
async function signIn(page: Page) {
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email').fill('ada@work.test');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your PigeonBox', exact: true })).toBeVisible();
  await page.goto('/dashboard#documents');
  await expect(page.getByRole('heading', { name: 'Tracked documents', exact: true })).toBeVisible();
}
async function api(page: Page, path: string, body: unknown) {
  return page.evaluate(async ({ path, body }) => {
    const { api } = await import('/lib/session.js');
    return api(path, { method: 'POST', body });
  }, { path, body });
}
async function share(page: Page, title: string, pages = 2) {
  const bytes = Buffer.from(await testPdf(pages));
  await page.getByLabel('PDF file', { exact: true }).setInputFiles({ name: 'proposal.pdf', mimeType: 'application/pdf', buffer: bytes });
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New link', exact: true })).toBeVisible();
  await page.getByLabel('Recipient email', { exact: true }).fill('maya@client.test');
  await page.getByLabel('Allow download', { exact: true }).check();
  const result = page.waitForResponse(response => response.url().endsWith('/v1/documents/links/create'));
  await page.getByRole('button', { name: 'Create link', exact: true }).click();
  const { link } = await (await result).json();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  return { ...link as { url: string; id: string; documentId: string }, bytes };
}
test('unfocused previews do not fetch a file or create a view; foreground opens directly and failed loads can retry', async ({ page, browser }, info) => {
  await signIn(page); const link = await share(page, 'Proposal & budget <2026> — ' + 'Quarterly-review-'.repeat(8));
  const context = await browser.newContext({ userAgent: UA });
  await context.addInitScript(() => { document.hasFocus = () => false; });
  const reader = await context.newPage();
  let sessions = 0; let files = 0;
  await reader.route('**/d/*/session', async route => {
    sessions++;
    if (sessions === 1) await route.fulfill({ status: 503, body: '{}' });
    else await route.continue();
  });
  await reader.route('**/d/*/file', async route => {
    files++;
    if (files === 1) await route.fulfill({ status: 503, body: 'Temporarily unavailable' });
    else await route.continue();
  });
  await reader.goto(link.url); await reader.waitForTimeout(300);
  expect(sessions).toBe(0); expect(files).toBe(0);
  expect((await api(page, '/v1/documents/analytics', { documentId: link.documentId })).links[0].views).toBe(0);
  await reader.bringToFront();
  await reader.evaluate(() => { delete (document as any).hasFocus; window.dispatchEvent(new FocusEvent('focus')); });
  await expect(reader.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await reader.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(reader.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  expect((await api(page, '/v1/documents/analytics', { documentId: link.documentId })).links[0].views).toBe(0);
  await reader.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(reader.locator('.page[data-page="1"]')).toHaveAttribute('data-rendered', 'true');
  expect(sessions).toBe(3); expect(files).toBe(2);
  await expect(reader.getByRole('button', { name: 'Try again', exact: true })).toBeHidden();
  await reader.screenshot({ path: info.outputPath('document-desktop.png') });
  await reader.locator('.document-info summary').click();
  await expect(reader.getByText(/The sender can see opens/)).toBeVisible();
  await reader.keyboard.press('Escape');
  await expect(reader.getByText(/The sender can see opens/)).toBeHidden();
  await reader.setViewportSize({ width: 320, height: 640 });
  await expect.poll(() => reader.locator('.page canvas').first().getAttribute('width')).toBe('288');
  await expect(reader.getByLabel('Page', { exact: true })).toHaveValue('1');
  expect(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await reader.screenshot({ path: info.outputPath('document-small-mobile.png') });
  await context.close();
});
test('real PDF viewer: automatic open, rendered pages, retry deduplication, mobile and revocation', async ({ page, browser }, info) => {
  test.setTimeout(65_000);
  await signIn(page); const link = await share(page, 'Browser proposal');
  const analytics = () => api(page, '/v1/documents/analytics', { documentId: link.documentId });
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 300 } });
  await context.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL);
    const blobs = new Map<string, Blob>();
    (window as any).__originalPdfBlobs = blobs;
    URL.createObjectURL = value => { const url = create(value); if (value instanceof Blob) blobs.set(url, value); return url; };
  });
  const reader = await context.newPage();
  let lostAck = false;
  await reader.route('**/d/*/events', async route => {
    if (!lostAck) { lostAck = true; await route.fetch(); await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); }
    else await route.continue();
  });
  await reader.goto(link.url);
  await reader.bringToFront();
  await expect(reader.getByRole('button', { name: 'Open document', exact: true })).toHaveCount(0);
  await expect(reader.locator('.page[data-page="1"]')).toHaveAttribute('data-rendered', 'true');
  // The page is taller than the viewport. Its rendered portion still counts.
  await expect.poll(async () => (await analytics()).links[0].views).toBe(1);
  await reader.waitForTimeout(1100);
  await reader.locator('.page[data-page="2"]').scrollIntoViewIfNeeded();
  await expect(reader.locator('.page[data-page="2"]')).toHaveAttribute('data-rendered', 'true');
  await reader.waitForTimeout(15_100); // queued observations retry after lost acknowledgement
  await expect.poll(async () => (await analytics()).links[0].pages?.length).toBe(2);
  expect((await analytics()).links[0].views).toBe(1);
  await reader.getByLabel('Zoom', { exact: true }).selectOption('150');
  await expect.poll(() => reader.locator('.page canvas').first().getAttribute('width')).toBe('1224');
  await reader.getByLabel('Zoom', { exact: true }).selectOption('auto');
  await reader.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(reader.getByLabel('Page', { exact: true })).toHaveValue('1');
  await reader.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(reader.getByLabel('Page', { exact: true })).toHaveValue('2');
  await reader.getByLabel('Page', { exact: true }).fill('1');
  await reader.getByLabel('Page', { exact: true }).press('Enter');
  await expect(reader.getByLabel('Page', { exact: true })).toHaveValue('1');
  const original = reader.waitForEvent('popup');
  await reader.getByRole('button', { name: 'Open PDF for printing', exact: true }).click();
  const native = await original; await expect.poll(() => native.url()).toMatch(/^blob:/);
  await native.waitForTimeout(1000);
  await native.screenshot({ path: info.outputPath('document-native-printing.png') });
  // Chromium renders native PDF UI outside the page DOM. Verify the exact
  // original bytes, and retain a screenshot of its native printing controls.
  const originalBytes = await reader.evaluate(async url => Array.from(new Uint8Array(await (window as any).__originalPdfBlobs.get(url).arrayBuffer())), native.url());
  expect(Buffer.from(originalBytes)).toEqual(link.bytes);
  await native.close(); await reader.bringToFront();
  expect((await analytics()).links[0].downloads).toBe(0);
  await reader.setViewportSize({ width: 390, height: 844 });
  await reader.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => reader.locator('.page canvas').first().getAttribute('width')).toBe('358');
  await expect(reader.locator('.page[data-page="1"]')).toHaveAttribute('data-rendered', 'true');
  expect(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(reader.locator('.watermark').first()).toContainText('maya@client.test');
  await reader.screenshot({ path: info.outputPath('document-mobile.png'), fullPage: true });
  const download = reader.waitForEvent('download');
  await reader.getByRole('link', { name: 'Download', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('proposal.pdf');
  await expect.poll(async () => (await analytics()).links[0].downloads).toBe(1);
  await api(page, '/v1/documents/links/revoke', { linkId: link.id });
  await reader.waitForTimeout(15_100);
  await expect(reader.getByText(/This link is no longer available/)).toBeVisible();
  expect((await context.request.get(link.url + '/file')).status()).toBe(404);
  await context.close();
});

test('sender preview survives a signed-out tab reload without adding views or downloads', async ({ page, browser }) => {
  await signIn(page); const link = await share(page, 'Sender preview proposal');
  const popup = page.waitForEvent('popup');
  const proofResponse = page.waitForResponse(response => response.url().endsWith('/v1/control/documents/preview'));
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const ownerPopup = await popup;
  await ownerPopup.waitForURL('**/d/**');
  const { url: previewUrl } = await (await proofResponse).json();
  expect(previewUrl).toContain('#preview=');
  await ownerPopup.close();
  const context = await browser.newContext({ userAgent: UA });
  const reader = await context.newPage();
  await reader.goto(previewUrl); // Gmail opens the API origin without dashboard credentials.
  await reader.bringToFront();
  await expect(reader.locator('.page[data-page="1"]')).toHaveAttribute('data-rendered', 'true');
  await expect(reader.locator('#tracking-status')).toHaveText('Sender preview — excluded from recipient activity.');
  expect(reader.url()).not.toContain('#preview=');
  await reader.reload();
  await reader.bringToFront();
  await expect(reader.locator('.page[data-page="1"]')).toHaveAttribute('data-rendered', 'true');
  await expect(reader.locator('#tracking-status')).toHaveText('Sender preview — excluded from recipient activity.');
  const download = reader.waitForEvent('download');
  await reader.getByRole('link', { name: 'Download', exact: true }).click(); await download;
  const data = await api(page, '/v1/documents/analytics', { documentId: link.documentId });
  expect(data.links[0]).toMatchObject({ views: 0, downloads: 0, visibleSeconds: null, precision: 'none' });
  await context.close();
  const restricted = await browser.newContext({ userAgent: UA });
  await restricted.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error('Storage disabled'); };
    Storage.prototype.setItem = () => { throw new Error('Storage disabled'); };
  });
  const privateReader = await restricted.newPage(); await privateReader.goto(previewUrl);
  await privateReader.bringToFront();
  await expect(privateReader.locator('.page[data-page="1"]')).toHaveAttribute('data-rendered', 'true');
  await privateReader.reload();
  await privateReader.bringToFront();
  await expect(privateReader.getByText(/Open a fresh sender preview/)).toBeVisible();
  expect((await api(page, '/v1/documents/analytics', { documentId: link.documentId })).links[0].views).toBe(0);
  await restricted.close();
});

test('offscreen pages release their canvases and render again without duplicate page observations', async ({ page, browser }) => {
  await signIn(page); const link = await share(page, 'Longer proposal', 7);
  const context = await browser.newContext({ userAgent: UA });
  const reader = await context.newPage(); await reader.goto(link.url);
  await reader.bringToFront();
  const first = reader.locator('.page[data-page="1"]'); const last = reader.locator('.page[data-page="7"]');
  await expect(first).toHaveAttribute('data-rendered', 'true');
  await last.scrollIntoViewIfNeeded(); await expect(last).toHaveAttribute('data-rendered', 'true');
  await expect(first).toHaveAttribute('data-rendered', 'false');
  await expect(first.locator('canvas')).toHaveAttribute('width', '0');
  await first.scrollIntoViewIfNeeded(); await expect(first).toHaveAttribute('data-rendered', 'true');
  const analytics = () => api(page, '/v1/documents/analytics', { documentId: link.documentId });
  await expect.poll(async () => (await analytics()).links[0].pages?.find((p: { page: number }) => p.page === 7)?.views).toBe(1);
  expect((await analytics()).links[0].pages.find((p: { page: number }) => p.page === 1).views).toBe(1);
  await context.close();
});

test('malformed PDFs fail upload without leaving a shareable entry', async ({ page }) => {
  await signIn(page);
  await page.getByLabel('PDF file', { exact: true }).setInputFiles({ name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n/Type /Page\n%%EOF') });
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByText('Choose a valid, unencrypted PDF with 1 to 500 pages.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'broken', exact: true })).toHaveCount(0);
});

test('offline observations survive closing the reader and replay in their original session on the next visit', async ({page,browser}) => {
  await signIn(page);const link=await share(page,'Offline proposal');
  const context=await browser.newContext({userAgent:UA,viewport:{width:1280,height:300}});
  let reader=await context.newPage();await reader.goto(link.url);
  await reader.bringToFront();
  await expect(reader.locator('.page[data-page="1"]')).toHaveAttribute('data-rendered','true');
  const analytics=()=>api(page,'/v1/documents/analytics',{documentId:link.documentId});
  await expect.poll(async()=>(await analytics()).links[0].views).toBe(1);
  await context.setOffline(true);
  await reader.locator('.page[data-page="2"]').scrollIntoViewIfNeeded();
  await expect(reader.locator('.page[data-page="2"]')).toHaveAttribute('data-rendered','true');
  await expect.poll(()=>reader.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('pigeonbox.document-activity:')).some(key=>JSON.parse(localStorage.getItem(key)!).queue.some((event:{kind:string;page?:number})=>event.kind==='page_view'&&event.page===2)))).toBe(true);
  await reader.close();await context.setOffline(false);
  let releaseBacklog!: () => void;
  const backlog = new Promise<void>(resolve => { releaseBacklog = resolve; });
  await context.route('**/d/*/events', async route => {
    if (route.request().postDataJSON().events.some((event: { kind: string; page?: number }) => event.kind === 'page_view' && event.page === 2)) await backlog;
    await route.continue();
  });
  reader=await context.newPage();await reader.goto(link.url);
  await reader.bringToFront();
  try {
    // Analytics retry must never hold up opening the document on the next visit.
    await expect(reader.locator('.page[data-page="1"]')).toHaveAttribute('data-rendered','true');
  } finally { releaseBacklog(); }
  await expect.poll(async()=>(await analytics()).links[0].pages?.find((entry:{page:number})=>entry.page===2)?.views).toBe(1);
  // A new visit has its own time budget. The old visit's page replay does not
  // add another start to that old session or duplicate its page observation.
  await expect.poll(async () => (await analytics()).links[0].views).toBe(2);
  await context.close();
});

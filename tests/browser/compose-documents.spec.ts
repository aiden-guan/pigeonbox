import { expect, test } from './fixtures';

test('a PDF is uploaded and inserted directly in its composer, then PDF activity appears beside the email', async ({ app }, info) => {
  await (await app.page('settings', true)).close();
  const page = await app.context.newPage(); await page.goto(`chrome-extension://${app.id}/document-fixture.html`);
  await page.getByRole('button', { name: 'Track PDF', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Track PDF', exact: true });
  await expect(dialog).toContainText('paperclip do not report opens');
  await dialog.getByLabel('Choose PDF to track').setInputFiles({ name: 'Proposal.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nfixture') });
  await expect(dialog.getByRole('status')).toContainText('Tracked PDF added');
  await expect(page.locator('#compose a')).toContainText('Proposal.pdf');
  await expect(page.locator('#compose a')).toContainText('PDF · 1 KB');
  await expect(page.locator('#compose img')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.screenshot({ path: info.outputPath('pdf-card-in-compose.png') });
  await expect(page.locator('#compose a')).toHaveAttribute('href', `${app.api.baseUrl}/d/${'a'.repeat(32)}`);
  expect(app.api.calls.filter(call => call.route === '/v1/documents/links/associate')).toHaveLength(0);
  expect(app.api.calls.find(call => call.route === '/v1/documents/links/create')?.body).toMatchObject({ allowDownload: true, watermark: false });
  await page.getByRole('button', { name: 'Simulate Gmail send' }).click();
  await expect.poll(() => app.api.calls.filter(call => call.route === '/v1/documents/links/associate').length).toBe(1);
  expect(app.api.calls.find(call => call.route === '/v1/documents/links/associate')?.body.threadId).toBe('abc123');
  await page.locator('.gi-track-btn').click();
  await expect.poll(() => app.api.calls.filter(call => call.route === '/v1/signals/thread').length).toBe(1);
  app.api.documentActivity = true;
  await expect(page.locator('.gi-track-activity')).toContainText('PDF opened', { timeout: 20_000 });
  await expect(page.locator('.gi-track-activity')).toContainText('PDF downloaded');
  await page.screenshot({ path: info.outputPath('pdf-activity-in-email.png') });
});

test('canceling or choosing a non-PDF leaves the draft and Cloud unchanged', async ({ app }) => {
  await (await app.page('settings', true)).close();
  const page = await app.context.newPage(); await page.goto(`chrome-extension://${app.id}/document-fixture.html`);
  await page.getByRole('button', { name: 'Track PDF', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Track PDF', exact: true }).click();
  await page.getByLabel('Choose PDF to track').setInputFiles({ name: 'not-a-pdf.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not PDF') });
  await expect(page.getByRole('status')).toHaveText('Choose a valid PDF file.');
  await expect(page.locator('#compose a')).toHaveCount(0);
  expect(app.api.calls.some(call => call.route.startsWith('/v1/documents/'))).toBe(false);
});

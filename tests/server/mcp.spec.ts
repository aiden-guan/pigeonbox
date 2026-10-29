import { test, expect, type Page } from './fixtures';

const authorizationId = '22222222-2222-4222-8222-222222222222';

async function signIn(page: Page, path = '/dashboard#developers') {
  await page.goto(path);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email').fill('ada@work.test');
  await page.getByRole('button', { name: /sign in/i }).click();
}

test('MCP setup explains the tracked-send route and the OAuth availability accurately', async ({ page }) => {
  await signIn(page);
  await expect(page.getByText('Tracked email from your AI assistant', { exact: true })).toBeVisible();
  await expect(page.getByText(/OAuth connections are not enabled on this server yet/)).toBeVisible();
  await expect(page.getByText(/Messages sent through another Gmail connector/)).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Connections & MCP' })).toHaveAttribute('aria-selected', 'true');
});

test('OAuth consent survives sign-in and requires an explicit choice of application permissions', async ({ page, baseURL }) => {
  const decisions: unknown[] = [];
  await page.route('**/v1/control/mcp/oauth/details', route => route.fulfill({ json: { authorizationId, clientId: '11111111-1111-4111-8111-111111111111', clientName: 'ChatGPT <script>unsafe()</script>', identityScopes: 'openid', redirectUri: 'https://chatgpt.com/connector/oauth/callback' } }));
  await page.route('**/v1/control/mcp/oauth/decide', async route => {
    decisions.push(route.request().postDataJSON());
    await route.fulfill({ json: { redirectUrl: `${baseURL}/__fixture/oauth-return` } });
  });
  await page.route('**/__fixture/oauth-return', route => route.fulfill({ body: '<p>Connected</p>', contentType: 'text/html' }));
  await signIn(page, `/dashboard?authorization_id=${authorizationId}`);
  await expect(page.getByRole('heading', { name: 'Connect ChatGPT <script>unsafe()</script>?' })).toBeVisible();
  await expect(page.locator('#view script')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: /^Read/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /^Write/ })).not.toBeChecked();
  expect(decisions).toEqual([]);
  await page.getByRole('checkbox', { name: /^Write/ }).check();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page).toHaveURL(/__fixture\/oauth-return/);
  expect(decisions).toEqual([{ authorizationId, decision: 'approve', scopes: ['read', 'write'] }]);
  expect(await page.evaluate(() => sessionStorage.getItem('pigeonbox.mcp.authorization'))).toBeNull();
});

test('an expired OAuth request can be cancelled without trapping the dashboard', async ({ page }) => {
  await page.route('**/v1/control/mcp/oauth/details', route => route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'The authorization request expired.' } } }));
  await signIn(page, `/dashboard?authorization_id=${authorizationId}`);
  await expect(page.getByRole('heading', { name: 'Connection could not continue' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel connection' }).click();
  await expect(page.getByText('Tracked email from your AI assistant', { exact: true })).toBeVisible();
});

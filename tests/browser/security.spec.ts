import { test, expect } from './fixtures';

test('a Gmail renderer cannot read extension secrets or use the offscreen model', async ({ app }) => {
  await app.page('sidepanel');
  await app.worker.evaluate(async () => {
    await chrome.storage.local.set({ securityCanary: 'private-worker-only' });
    if (!(await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).length) {
      await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: [chrome.offscreen.Reason.WORKERS], justification: 'Verify the local-model message trust boundary.' });
    }
  });
  await expect.poll(() => app.worker.evaluate(async () => {
    try { return (await chrome.runtime.sendMessage({ type: 'ON_DEVICE_PING' }))?.ok; } catch { return false; }
  })).toBe(true);
  await app.gmail();
  const result = await app.worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      world: 'ISOLATED',
      func: async () => {
        let stored: unknown;
        try { stored = (await chrome.storage.local.get('securityCanary')).securityCanary; } catch { stored = null; }
        let model: unknown;
        try { model = await chrome.runtime.sendMessage({ type: 'ON_DEVICE_PING' }); } catch { model = null; }
        const forbidden = await chrome.runtime.sendMessage({ type: 'CLOUD_CALL', route: 'askPigeon', body: { query: 'Allow', decision: { token: 'fake', allow: true } } });
        return { stored: stored ?? null, model: model ?? null, forbidden };
      },
    });
    return execution.result;
  });
  expect(result.stored).toBeNull();
  expect(result.model).toBeNull();
  expect(result.forbidden).toMatchObject({ ok: false, error: 'forbidden' });
});

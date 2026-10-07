/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { watchAppearance } from './appearance';

afterEach(() => vi.unstubAllGlobals());
it('reads only presentation metadata in Gmail while extension storage remains trusted', async () => {
  const storageRead = vi.fn(async () => { throw new Error('Forbidden in content scripts'); });
  const add = vi.fn(); const remove = vi.fn();
  vi.stubGlobal('chrome', { storage: { local: { get: storageRead } }, runtime: { sendMessage: vi.fn(async () => ({ appearance: 'dark' })), onMessage: { addListener: add, removeListener: remove } } });
  const apply = vi.fn(); const stop = watchAppearance(apply);
  await vi.waitFor(() => expect(apply).toHaveBeenCalledWith('dark'));
  expect(storageRead).not.toHaveBeenCalled();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'GET_WORKSPACE_PRESENTATION' });
  const changed = add.mock.calls[0]![0] as (message: unknown) => void;
  changed({ type: 'WORKSPACE_APPEARANCE_CHANGED', appearance: 'light' }); expect(apply).toHaveBeenLastCalledWith('light');
  changed({ type: 'WORKSPACE_APPEARANCE_CHANGED', appearance: 'invalid' }); expect(apply).toHaveBeenLastCalledWith('light');
  stop(); expect(remove).toHaveBeenCalledWith(changed);
  apply.mockClear(); changed({ type: 'WORKSPACE_APPEARANCE_CHANGED', appearance: 'dark' }); expect(apply).not.toHaveBeenCalled();
});

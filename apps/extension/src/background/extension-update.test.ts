import { describe, expect, it, vi } from 'vitest';
import { GITHUB_RELEASES_URL, WEB_STORE_URL, requestExtensionUpdate } from './extension-update';

function deps(store: boolean, status = 'no_update') {
  return { managedByStore: vi.fn(async () => store), requestUpdateCheck: vi.fn(async () => ({ status })), reload: vi.fn(), openTab: vi.fn(async () => undefined) };
}

describe('update PigeonBox action', () => {
  it('restarts a Web Store copy into a downloaded update', async () => {
    vi.useFakeTimers();
    const d = deps(true, 'update_available');
    expect(await requestExtensionUpdate(d)).toEqual({ ok: true, outcome: 'restarting' });
    await vi.advanceTimersByTimeAsync(300);
    expect(d.reload).toHaveBeenCalledOnce();
    expect(d.openTab).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('opens the store listing when no update is ready yet', async () => {
    const d = deps(true, 'no_update');
    expect(await requestExtensionUpdate(d)).toEqual({ ok: true, outcome: 'opened_store' });
    expect(d.openTab).toHaveBeenCalledWith(WEB_STORE_URL);
  });

  it('does not open anything when Chrome throttles update checks', async () => {
    const d = deps(true, 'throttled');
    expect((await requestExtensionUpdate(d)).outcome).toBe('throttled');
    expect(d.openTab).not.toHaveBeenCalled();
  });

  it('sends unpacked copies to GitHub releases without asking Chrome', async () => {
    const d = deps(false);
    expect((await requestExtensionUpdate(d)).outcome).toBe('opened_releases');
    expect(d.openTab).toHaveBeenCalledWith(GITHUB_RELEASES_URL);
    expect(d.requestUpdateCheck).not.toHaveBeenCalled();
  });
});

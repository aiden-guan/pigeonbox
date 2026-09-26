/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GMAIL_RELOAD_AFTER_RESTART_KEY } from '../reload-extension';
import { PopupApp } from './PopupApp';

vi.mock('../config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config')>()),
  DEV_REBUILD_URL: '',
}));

describe('extension menu reload', () => {
  let root: Root | null = null;

  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = '';
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('shows a reload action that restarts the extension', async () => {
    const set = vi.fn(async () => undefined);
    const reload = vi.fn();
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { reload },
      storage: { local: { set } },
    };

    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<PopupApp />);
    });

    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Reload extension');
    expect(button).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(set).toHaveBeenCalledWith({ [GMAIL_RELOAD_AFTER_RESTART_KEY]: true });
    expect(reload).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('Reloading…');
  });
});

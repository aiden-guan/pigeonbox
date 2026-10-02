import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showWorkspace, readWorkspace, updateWorkspace, installWorkspaceToolbar } from './workspace';
import { DEFAULT_WORKSPACE, workspaceState } from '../workspace/state';
let local: Record<string, unknown>; let session: Record<string, unknown>;
const gmail = { id: 2, windowId: 1, url: 'https://mail.google.com/mail/u/1/#inbox', active: false };
beforeEach(() => {
  local = {}; session = {};
  const area = (store: Record<string, unknown>) => ({ get: vi.fn(async (key: string) => ({ [key]: store[key] })), set: vi.fn(async (row: Record<string, unknown>) => Object.assign(store, row)) });
  vi.stubGlobal('chrome', { storage: { local: area(local), session: area(session) }, tabs: { query: vi.fn(async () => [gmail]), update: vi.fn(), create: vi.fn(async () => ({ id: 3 })), sendMessage: vi.fn(async () => ({ ok: true })) }, windows: { update: vi.fn() }, action: { onClicked: { addListener: vi.fn() } }, sidePanel: {} });
});
afterEach(() => vi.unstubAllGlobals());
describe('canonical workspace state and toolbar', () => {
  it('migrates legacy navigation safely and bounds untrusted presentation data', () => {
    expect(workspaceState(null, { mode: 'cloud', splitCategory: 'WAITING' })).toMatchObject({ mode: 'home', splitCategory: 'WAITING', display: 'float' });
    expect(workspaceState({ mode: 'made-up', position: { right: NaN, top: 2 }, size: { width: Infinity } })).toMatchObject({ ...DEFAULT_WORKSPACE, position: undefined, size: undefined });
  });
  it('collapses and reopens an active Gmail workspace while preserving position, size and navigation', async () => {
    await updateWorkspace({ ...DEFAULT_WORKSPACE, position: { right: 21, top: 77 }, size: { width: 410, height: 590 }, mode: 'ask' });
    await showWorkspace(gmail, true); expect((await readWorkspace()).open).toBe(false);
    await showWorkspace(gmail, true); expect(await readWorkspace()).toMatchObject({ open: true, mode: 'ask', position: { right: 21, top: 77 }, size: { width: 410, height: 590 } });
  });
  it('focuses the appropriate existing Gmail account when invoked from another tab', async () => {
    await showWorkspace({ id: 1, windowId: 1, url: 'https://example.com' }, true);
    expect(chrome.tabs.update).toHaveBeenCalledWith(2, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
    expect(chrome.tabs.create).not.toHaveBeenCalled(); expect((await readWorkspace()).open).toBe(true);
  });
  it('opens Gmail once and queues reopening until its content integration is ready', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([]);
    vi.mocked(chrome.tabs.sendMessage).mockRejectedValue(new Error('No receiver'));
    await showWorkspace({ id: 1, url: 'https://example.com' }, true);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://mail.google.com/mail/u/0/#inbox' });
    expect(session.workspaceReopen).toEqual({ tabId: 3 });
  });
  it('installs the toolbar handler instead of a popup and restores legacy navigation', async () => {
    installWorkspaceToolbar(); expect(chrome.action.onClicked.addListener).toHaveBeenCalledOnce();
    session.panelState = { mode: 'ask', splitCategory: 'WAITING' }; expect(await readWorkspace()).toMatchObject({ mode: 'ask', splitCategory: 'WAITING' });
  });
});

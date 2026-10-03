// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./float-drag', () => ({ installFloatDrag: vi.fn(), placeFloat: vi.fn() }));
vi.mock('../../ui/appearance', () => ({ watchAppearance: vi.fn() }));

const box = (width: number, height: number) => new DOMRect(100, 80, width, height);
let workspace: typeof import('./workspace');
let host: HTMLElement;
let shell: HTMLElement;
let animate: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('chrome', { runtime: {
    getURL: (path: string) => `https://extension.test/${path}`,
    sendMessage: vi.fn().mockResolvedValue(undefined),
  } });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  animate = vi.fn(() => ({ cancel: vi.fn() }));
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate });
  workspace = await import('./workspace');
  host = workspace.ensureWorkspace();
  shell = host.shadowRoot!.querySelector<HTMLElement>('.gi-shell')!;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, 'animate');
  document.body.replaceChildren();
});

describe('floating workspace morph geometry', () => {
  it.each([
    ['hidden source', box(0, 0), box(380, 600)],
    ['zero source width', box(0, 44), box(380, 600)],
    ['zero source height', box(144, 0), box(380, 600)],
    ['hidden destination', box(144, 44), box(0, 0)],
    ['non-finite source', box(Infinity, 44), box(380, 600)],
    ['non-finite destination', box(144, 44), box(380, NaN)],
  ])('skips the morph for %s while applying the new presentation', (_name, before, after) => {
    workspace.updateFloatingWorkspace({ display: 'dock', open: false });
    animate.mockClear();
    vi.spyOn(shell, 'getBoundingClientRect').mockReturnValueOnce(before).mockReturnValueOnce(after);
    workspace.updateFloatingWorkspace({ display: 'float', open: true });
    expect(animate).not.toHaveBeenCalled();
    expect(host.dataset).toMatchObject({ display: 'float', open: 'true' });
    expect(host.shadowRoot!.querySelector<HTMLIFrameElement>('iframe')!.inert).toBe(false);
  });

  it('keeps visible morph keyframes finite and cancels an interrupted transition', () => {
    const rect = vi.spyOn(shell, 'getBoundingClientRect');
    rect.mockReturnValueOnce(box(380, 600)).mockReturnValueOnce(box(144, 44));
    workspace.showFloatingWorkspace(false);
    const running = animate.mock.results.map((result) => result.value);
    expect(animate).toHaveBeenCalled();
    animate.mockClear();
    // Reopen while the collapsed surface is still partway through its morph.
    rect.mockReturnValueOnce(box(240, 280)).mockReturnValueOnce(box(380, 600));
    workspace.showFloatingWorkspace(true);
    running.forEach((animation) => expect(animation.cancel).toHaveBeenCalledOnce());
    const frames = animate.mock.calls[0][0] as Keyframe[];
    expect(frames[0].transform).toContain(`scale(${240 / 380},${280 / 600})`);
    expect(JSON.stringify(animate.mock.calls)).not.toMatch(/Infinity|NaN/);
  });

  it('still restores collapse focus when geometry is unavailable', () => {
    workspace.showFloatingWorkspace(false);
    expect(animate).not.toHaveBeenCalled();
    expect(host.shadowRoot!.activeElement).toBe(host.shadowRoot!.querySelector('.gi-pill'));
  });

  it('respects reduced motion with measurable geometry', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue(box(380, 600));
    workspace.showFloatingWorkspace(false);
    expect(animate).not.toHaveBeenCalled();
    expect(host.dataset.open).toBe('false');
  });
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DotField } from './DotField';

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });
it('allocates no hidden or idle work, settles once, and cancels when motion is reduced', async () => {
  let observerCallback: IntersectionObserverCallback | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { observerCallback = callback; }
    observe() {} disconnect = disconnect;
  });
  let reduceListener: (() => void) | undefined;
  const media = { matches:false, addEventListener:(_type: string, callback: () => void) => { reduceListener = callback; }, removeEventListener:vi.fn() };
  vi.stubGlobal('matchMedia', () => media);
  const animations: Array<{ cancel: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn>; playState: string }> = [];
  const animate = vi.fn(() => { const item = { cancel:vi.fn(), pause:vi.fn(), play:vi.fn(), playState:'running' }; animations.push(item); return item; });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue:(name: string) => name === '--pb-ease' ? 'ease-out' : '680ms' }));
  const original = Element.prototype.animate;
  Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<DotField state="idle" />));
    expect(animate).not.toHaveBeenCalled();
    await act(async () => root.render(<DotField state="analyzing" />));
    expect(animate).not.toHaveBeenCalled();
    observerCallback!([{ isIntersecting:true } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(animate).toHaveBeenCalledTimes(35);
    expect(animate.mock.calls.every((call) => { const options = (call as unknown[])[1] as KeyframeAnimationOptions; return options.duration === 680 && options.iterations !== Infinity; })).toBe(true);
    observerCallback!([{ isIntersecting:false } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(animations.every((item) => item.pause.mock.calls.length === 1)).toBe(true);
    observerCallback!([{ isIntersecting:true } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(animate).toHaveBeenCalledTimes(35);
    media.matches = true; reduceListener!();
    expect(animations.every((item) => item.cancel.mock.calls.length === 1)).toBe(true);
    await act(async () => root.unmount());
    expect(disconnect).toHaveBeenCalled();
    expect(media.removeEventListener).toHaveBeenCalled();
  } finally { Element.prototype.animate = original; }
});

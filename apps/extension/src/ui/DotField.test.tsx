// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DotField } from './DotField';
import { createOrb } from './orb-markup';

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });
it('keeps idle static and pauses CSS work offscreen and in background tabs, with observer cleanup', async () => {
  const observers: Array<{ callback: IntersectionObserverCallback; disconnect: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { observers.push({ callback, disconnect: this.disconnect }); }
    observe() {} disconnect = vi.fn();
  });
  let hidden = false;
  const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
  Object.defineProperty(document, 'hidden', { configurable:true, get:() => hidden });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<DotField state="idle" />));
    expect(observers).toHaveLength(0);
    await act(async () => root.render(<DotField state="analyzing" />));
    const orb = host.querySelector<HTMLElement>('.gi-orb')!;
    expect(orb.dataset.visible).toBe('false');
    const intersection = (visible: boolean) => observers[0].callback([{ isIntersecting:visible } as IntersectionObserverEntry], {} as IntersectionObserver);
    intersection(true);
    expect(orb.dataset.visible).toBe('true');
    hidden = true; document.dispatchEvent(new Event('visibilitychange'));
    expect(orb.dataset.visible).toBe('false');
    hidden = false; document.dispatchEvent(new Event('visibilitychange'));
    expect(orb.dataset.visible).toBe('true');
    intersection(false);
    expect(orb.dataset.visible).toBe('false');
    await act(async () => root.render(<DotField state="success" onAccent />));
    expect(orb.dataset.state).toBe('success');
    expect(orb.classList.contains('is-on-accent')).toBe(true);
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
    expect(observers[1].disconnect).toHaveBeenCalledOnce();
  } finally {
    if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden);
    else Reflect.deleteProperty(document, 'hidden');
  }
});
it('shares ID-free artwork with plain-DOM busy toasts and never replaces the adjacent status label', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(<p role="status"><DotField state="drafting" size={16} />Drafting…</p>));
  const reactOrb = host.querySelector('.gi-orb')!;
  const domOrb = createOrb(16, 'bare', 'drafting');
  expect(domOrb.innerHTML).toBe(reactOrb.innerHTML);
  expect(domOrb.querySelector('[id]')).toBeNull();
  // The same markup ships in the site's strict style-src 'self' walkthrough.
  expect(domOrb.querySelector('[style]')).toBeNull();
  expect(domOrb.getAttribute('aria-hidden')).toBe('true');
  expect(host.querySelector('[role="status"]')!.textContent).toBe('Drafting…');
  expect(domOrb.dataset.visible).toBe('false');
  await act(async () => root.unmount());
});

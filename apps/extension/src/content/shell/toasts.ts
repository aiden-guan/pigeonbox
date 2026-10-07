import { knownAppearance } from '../../ui/appearance';
import { observeVisual } from '../../ui/motion';
import { createOrb } from '../../ui/orb-markup';
import { ensureSurface, SURFACE_CSS } from './surface';

let disposeToast: (() => void) | undefined;

/** A toast for work in progress; the next toast replaces it. */
export function showBusyToast(message: string): void {
  showToast(message, undefined, true);
}

export function showToast(message: string, retry?: () => void, busy = false, actionLabel = 'Retry'): void {
  disposeToast?.();
  document.querySelector('[data-gi-ui="toast"]')?.remove();
  ensureSurface();
  const host = document.createElement('div');
  host.setAttribute('data-gi-ui', 'toast');
  host.dataset.pbTheme = knownAppearance();
  host.style.cssText = 'position:fixed;left:0;right:0;bottom:24px;z-index:2147483646;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = SURFACE_CSS;
  const wrap = document.createElement('div');
  wrap.className = 'gi-toast-wrap';
  const toast = document.createElement('div');
  toast.className = 'gi-toast';
  const text = document.createElement('span');
  text.textContent = message;
  const orb = busy ? createOrb(16, 'bare') : null;
  if (orb) toast.append(orb);
  toast.setAttribute('role', 'status');
  toast.append(text);
  if (retry) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gi-toast-retry';
    button.textContent = actionLabel;
    button.onclick = () => {
      disposeToast?.();
      retry();
    };
    toast.append(button);
  }
  wrap.append(toast);
  shadow.append(style, wrap);
  document.documentElement.append(host);
  const unobserve = orb ? observeVisual(orb, (visible) => { orb.dataset.visible = String(visible); }) : undefined;
  const dispose = () => { unobserve?.(); window.clearTimeout(timer); host.remove(); if (disposeToast === dispose) disposeToast = undefined; };
  const timer = window.setTimeout(dispose, 6000);
  disposeToast = dispose;
}

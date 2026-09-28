import { createOrb } from '../../ui/orb-markup';
import { ensureSurface, SURFACE_CSS } from './surface';

/** A toast for work in progress; the next toast replaces it. */
export function showBusyToast(message: string): void {
  showToast(message, undefined, true);
}

export function showToast(message: string, retry?: () => void, busy = false): void {
  document.querySelector('[data-gi-ui="toast"]')?.remove();
  ensureSurface();
  const host = document.createElement('div');
  host.setAttribute('data-gi-ui', 'toast');
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
  if (busy) toast.append(createOrb(16, 'bare'));
  toast.append(text);
  if (retry) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gi-toast-retry';
    button.textContent = 'Retry';
    button.onclick = () => {
      host.remove();
      retry();
    };
    toast.append(button);
  }
  wrap.append(toast);
  shadow.append(style, wrap);
  document.documentElement.append(host);
  window.setTimeout(() => host.remove(), 6000);
}

import { useLayoutEffect, useRef } from 'react';
import { motionOptions, prefersReducedMotion } from './motion';
type Transfer = { at: number; rect: DOMRect; parts: Map<string, DOMRect> };
const transfers = new Map<string, Transfer>();
/** Store geometry only. No email text or DOM clones survive the source view. */
export function rememberTransfer(node: HTMLElement, key: string) {
  transfers.clear();
  transfers.set(key, { at: performance.now(), rect: node.getBoundingClientRect(), parts: new Map([...node.querySelectorAll<HTMLElement>('[data-continuity]')].map((part) => [part.dataset.continuity!, part.getBoundingClientRect()])) });
}
export function useTransfer<T extends HTMLElement>(key: string) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const node = ref.current, source = transfers.get(key);
    transfers.delete(key);
    if (!node || !source || performance.now() - source.at > 1200 || prefersReducedMotion() || typeof node.animate !== 'function') return;
    const target = node.getBoundingClientRect();
    if (!target.width || !target.height) return;
    const options = motionOptions(node, 'expressive');
    const sheet = document.createElement('div');
    sheet.setAttribute('aria-hidden', 'true');
    sheet.inert = true;
    const style = getComputedStyle(node);
    Object.assign(sheet.style, { position:'fixed', left:`${target.left}px`, top:`${target.top}px`, width:`${target.width}px`, height:`${target.height}px`, border:`1px solid ${style.getPropertyValue('--pb-border')}`, borderRadius:style.getPropertyValue('--pb-radius'), background:style.getPropertyValue('--pb-surface-raised'), pointerEvents:'none', zIndex:'2', transformOrigin:'top left' });
    document.body.append(sheet);
    const shell = sheet.animate([
      { transform:`translate(${source.rect.left - target.left}px,${source.rect.top - target.top}px) scale(${source.rect.width / target.width},${source.rect.height / target.height})`, opacity:.8 },
      { transform:'none', opacity:0 },
    ], options);
    shell.finished.then(() => sheet.remove()).catch(() => sheet.remove());
    const animations = [shell];
    node.querySelectorAll<HTMLElement>('[data-continuity]').forEach((part) => {
      const old = source.parts.get(part.dataset.continuity!), next = part.getBoundingClientRect();
      if (old) animations.push(part.animate([{ transform:`translate(${old.left - next.left}px, ${old.top - next.top}px)` }, { transform:'none' }], options));
    });
    return () => { animations.forEach((item) => item.cancel()); sheet.remove(); };
  }, [key]);
  return ref;
}

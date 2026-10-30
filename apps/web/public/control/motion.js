// Motion for the control plane: page transitions, staggered resolves and
// one-shot moments. Decoration only: every state is also said in text, and
// nothing waits on an animation. Reduced motion turns all of it into, at
// most, a short opacity fade (control.css).
import { h, pidgy, stamp } from './ui.js';

const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');
const fineQuery = matchMedia('(hover: hover) and (pointer: fine)');

export const reduced = () => reducedQuery.matches;
export const finePointer = () => fineQuery.matches;

/** Run `callback` whenever reduced motion or pointer capability changes. */
export function onPreferenceChange(callback) {
  reducedQuery.addEventListener('change', callback);
  fineQuery.addEventListener('change', callback);
}

/** The current page dims and settles while the next one loads. */
export function leave(view) {
  if (!view.firstElementChild) return;
  view.classList.remove('is-entering');
  view.classList.add('is-leaving');
}

let entering = 0;

/**
 * The next page resolves upward, masthead first, then its blocks in order.
 * With `masthead: false` (the masthead is already showing) only the blocks settle.
 */
export function enter(view, { masthead = true } = {}) {
  view.classList.remove('is-leaving', 'is-entering', 'is-settling');
  const page = view.querySelector(':scope > .page');
  if (page) [...page.children].forEach((child, position) => child.style.setProperty('--i', String(Math.min(position, 7))));
  void view.offsetWidth;
  const name = masthead ? 'is-entering' : 'is-settling';
  view.classList.add(name);
  clearTimeout(entering);
  entering = setTimeout(() => view.classList.remove(name), 1_100);
}

/**
 * A short, one-time moment beside something that just happened: Pidgy acts
 * out the state and a stamp lands. Removed when done; never repeats.
 */
export function celebrate(target, { state = 'parcel', text = 'Sent', small = '' } = {}) {
  if (!target?.isConnected) return;
  target.querySelector(':scope > .celebration')?.remove();
  const moment = h('div', { class: 'celebration', attrs: { 'aria-hidden': 'true' } }, pidgy(state, { size: 'lg' }), stamp(text, small));
  if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
  target.append(moment);
  setTimeout(() => moment.remove(), reduced() ? 2_000 : 2_900);
}

/** Swap a Pidgy to another state for one performance, then back. */
export function perform(bird, state, ms = 2_400) {
  if (!bird) return;
  const rest = bird.dataset.state;
  bird.dataset.state = state;
  setTimeout(() => {
    if (bird.isConnected) bird.dataset.state = rest;
  }, reduced() ? Math.min(ms, 1_800) : ms);
}

/** Slide the rail's copper marker to the current link. */
export function placeMarker(marker, link, { instant = false } = {}) {
  if (!marker) return;
  if (!link || !link.offsetParent) {
    marker.classList.remove('is-on');
    return;
  }
  const nav = marker.parentElement;
  const y = link.getBoundingClientRect().top - nav.getBoundingClientRect().top + nav.scrollTop + (link.offsetHeight - marker.offsetHeight) / 2;
  marker.classList.toggle('is-instant', instant || !marker.classList.contains('is-on'));
  marker.style.setProperty('--y', `${Math.round(y)}px`);
  marker.classList.add('is-on');
}

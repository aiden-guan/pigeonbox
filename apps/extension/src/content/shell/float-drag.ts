/**
 * Lets the floating thread card (and its docked pill) be dragged around and resized.
 * Position is anchored to the top-right corner so the pill and open card share an anchor.
 */

export type FloatPos = { right: number; top: number };
export type FloatSize = { width: number; height: number };
type Box = { width: number; height: number };

const POS_KEY = 'gi.float.pos';
const SIZE_KEY = 'gi.float.size';
const MARGIN = 8;
const DRAG_SLOP = 4;
export const SIZE_LIMITS = { minWidth: 280, maxWidth: 520, minHeight: 240 };

export function clampPos(pos: FloatPos, box: Box, viewport: Box): FloatPos {
  const maxRight = Math.max(MARGIN, viewport.width - box.width - MARGIN);
  const maxTop = Math.max(MARGIN, viewport.height - box.height - MARGIN);
  return {
    right: Math.round(Math.min(Math.max(pos.right, MARGIN), maxRight)),
    top: Math.round(Math.min(Math.max(pos.top, MARGIN), maxTop)),
  };
}

/** `room` is the space available to the left of the card's right edge and below its top. */
export function clampSize(size: FloatSize, room: Box): FloatSize {
  const maxWidth = Math.max(SIZE_LIMITS.minWidth, Math.min(SIZE_LIMITS.maxWidth, room.width - MARGIN));
  const maxHeight = Math.max(SIZE_LIMITS.minHeight, room.height - MARGIN);
  return {
    width: Math.round(Math.min(Math.max(size.width, SIZE_LIMITS.minWidth), maxWidth)),
    height: Math.round(Math.min(Math.max(size.height, SIZE_LIMITS.minHeight), maxHeight)),
  };
}

function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function save(key: string, value: unknown): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

/** The layout viewport a fixed element is positioned against (excludes page scrollbars). */
function viewport(): Box {
  const root = document.documentElement;
  return { width: root.clientWidth || window.innerWidth, height: root.clientHeight || window.innerHeight };
}

function applyPos(host: HTMLElement, pos: FloatPos): void {
  host.style.setProperty('right', `${pos.right}px`, 'important');
  host.style.setProperty('top', `${pos.top}px`, 'important');
}

function applySize(host: HTMLElement, size: FloatSize | null): void {
  if (size) {
    host.style.setProperty('--gi-w', `${size.width}px`);
    host.style.setProperty('--gi-h', `${size.height}px`);
  } else {
    host.style.removeProperty('--gi-w');
    host.style.removeProperty('--gi-h');
  }
}

/** Places the card: a position the user dragged to wins over the computed default. */
export function placeFloat(host: HTMLElement, fallback: FloatPos): void {
  const saved = load<FloatPos>(POS_KEY);
  const rect = host.getBoundingClientRect();
  applyPos(host, clampPos(saved ?? fallback, rect, viewport()));
  const size = load<FloatSize>(SIZE_KEY);
  applySize(host, size ? clampSize(size, { width: viewport().width - (saved ?? fallback).right, height: viewport().height }) : null);
}

type Gesture =
  | { kind: 'drag'; pointerId: number; x: number; y: number; start: FloatPos; moved: boolean }
  | { kind: 'resize'; pointerId: number; x: number; y: number; start: FloatSize; right: number; top: number };

/** Wires drag ([data-gi-drag]) and resize ([data-gi-resize]) handles rendered inside the host's shadow root. */
export function installFloatDrag(host: HTMLElement, fallback: () => FloatPos): void {
  let gesture: Gesture | null = null;
  let swallowClick = false;

  const handleFor = (event: Event): 'drag' | 'resize' | null => {
    for (const node of event.composedPath()) {
      if (node === host || !(node instanceof HTMLElement)) break;
      if (node.hasAttribute('data-gi-resize')) return 'resize';
      if (node.hasAttribute('data-gi-drag')) return 'drag';
      if (node.matches('button, a, input, textarea, select, [contenteditable]')) return null;
    }
    return null;
  };

  const currentPos = (): FloatPos => {
    const rect = host.getBoundingClientRect();
    return { right: viewport().width - rect.right, top: rect.top };
  };

  const onMove = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (gesture.kind === 'drag') {
      if (!gesture.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
      gesture.moved = true;
      host.setAttribute('data-gi-dragging', '');
      const next = { right: gesture.start.right - dx, top: gesture.start.top + dy };
      applyPos(host, clampPos(next, host.getBoundingClientRect(), viewport()));
    } else {
      // The grip sits bottom-left and the card is right-anchored, so dragging left widens it.
      const next = { width: gesture.start.width - dx, height: gesture.start.height + dy };
      const room = { width: viewport().width - gesture.right, height: viewport().height - gesture.top };
      applySize(host, clampSize(next, room));
    }
  };

  const onUp = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (gesture.kind === 'drag' && gesture.moved) {
      save(POS_KEY, currentPos());
      swallowClick = true;
      setTimeout(() => (swallowClick = false), 0);
    } else if (gesture.kind === 'resize') {
      const shell = host.shadowRoot?.querySelector<HTMLElement>('.gi-shell');
      if (shell) save(SIZE_KEY, { width: shell.offsetWidth, height: shell.offsetHeight });
    }
    gesture = null;
    host.removeAttribute('data-gi-dragging');
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onUp, true);
  };

  host.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0 || gesture) return;
      const handle = handleFor(event);
      if (!handle) return;
      if (handle === 'drag') {
        gesture = { kind: 'drag', pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: currentPos(), moved: false };
      } else {
        const shell = host.shadowRoot?.querySelector<HTMLElement>('.gi-shell');
        if (!shell) return;
        const pos = currentPos();
        gesture = {
          kind: 'resize',
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          start: { width: shell.offsetWidth, height: shell.offsetHeight },
          right: pos.right,
          top: pos.top,
        };
        host.setAttribute('data-gi-dragging', '');
      }
      event.preventDefault();
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
    },
    true,
  );

  // A drag that ends on the pill must not also toggle it open.
  host.addEventListener(
    'click',
    (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.stopPropagation();
      event.preventDefault();
    },
    true,
  );

  // Double-click the header to put the card back where it started.
  host.addEventListener('dblclick', (event) => {
    if (handleFor(event) !== 'drag' || !host.shadowRoot?.querySelector('.gi-shell')) return;
    save(POS_KEY, null);
    save(SIZE_KEY, null);
    placeFloat(host, fallback());
  });

  // Opening/closing changes the card's footprint; keep it on screen without overwriting the saved spot.
  if (typeof ResizeObserver === 'undefined') return;
  new ResizeObserver(() => {
    if (gesture) return;
    applyPos(host, clampPos(currentPos(), host.getBoundingClientRect(), viewport()));
  }).observe(host);
}

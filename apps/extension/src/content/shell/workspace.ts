import { installFloatDrag, placeFloat } from './float-drag';
import { DEFAULT_WORKSPACE, workspaceState, type WorkspaceState } from '../../workspace/state';
import productTokens from '../../ui/product-tokens.css?inline';
import { applyTheme, normalizeAppearance, watchAppearance } from '../../ui/appearance';
import { motionOptions, prefersReducedMotion } from '../../ui/motion';
const CSS = `${productTokens}
:host{all:initial;position:fixed;right:24px;top:80px;z-index:1100;display:block;color:var(--pb-fg);font:var(--pb-size-secondary) var(--pb-sans);isolation:isolate;contain:layout style}
*{box-sizing:border-box}button{font:inherit;color:inherit;cursor:pointer}button:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--pb-border-focus);outline-offset:3px}
.gi-shell{width:var(--gi-w,380px);height:var(--gi-h,600px);max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);display:flex;flex-direction:column;background:var(--pb-surface-raised);border:1px solid var(--pb-border-strong);border-radius:var(--pb-radius-shell);overflow:hidden;box-shadow:var(--pb-shadow-float);transform-origin:top right}
header{height:38px;flex-shrink:0;display:flex;align-items:center;padding:0 var(--pb-space-2) 0 46px;gap:var(--pb-space-2);background:var(--pb-surface-raised);border-bottom:1px solid var(--pb-border);touch-action:none;cursor:grab}header span{flex:1;color:var(--pb-fg-muted);font-size:var(--pb-size-meta)}header button{border:0;background:transparent;padding:var(--pb-space-1);width:var(--pb-target);height:var(--pb-target);border-radius:var(--pb-radius-sm)}
iframe{border:0;flex:1;min-height:0;width:100%;background:var(--pb-surface)}
.gi-pill{position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-start;padding:0 var(--pb-space-3) 0 44px;background:transparent;border:0;border-radius:var(--pb-radius-pill);touch-action:none;text-align:left}.gi-pill span{font-size:var(--pb-size-label);font-weight:var(--pb-weight-medium)}
.pidgy{position:absolute;left:10px;top:7px;width:30px;height:24px;background-size:120px 120px;background-position:0 0;pointer-events:none;image-rendering:pixelated;z-index:2}
.pidgy[data-state=ready]:after{content:'';position:absolute;right:0;bottom:0;width:5px;height:5px;border-radius:50%;background:var(--pb-success)}
.gi-resize{position:absolute;left:1px;bottom:1px;width:24px;height:24px;border:0;background:transparent;cursor:sw-resize;touch-action:none;color:var(--pb-fg-muted);font-size:18px}.gi-resize:after{content:'⌞'}
:host([data-open=false]) .gi-shell{width:144px;height:44px;border-radius:var(--pb-radius-pill);box-shadow:var(--pb-shadow-low)}
:host([data-open=false]) header,:host([data-open=false]) iframe,:host([data-open=false]) .gi-resize{visibility:hidden;pointer-events:none}
:host([data-open=true]) .gi-pill{display:none}:host([data-gi-dragging]) iframe{pointer-events:none}:host([data-display=dock]){display:none}
@media(hover:hover) and (pointer:fine){header button:hover{background:var(--pb-surface-inset)}.gi-pill:hover{background:var(--pb-surface-inset)}}
@media(prefers-reduced-motion:reduce){.gi-shell{animation:none}}
@media(prefers-reduced-transparency:reduce){.gi-shell{box-shadow:none}}
`;
let state: WorkspaceState = { ...DEFAULT_WORKSPACE };
let host: HTMLElement | null = null;
let restoreFocus: HTMLElement | null = null;
let motion: Animation[] = [];
let lastGeometry = "";
function persist(patch: Partial<WorkspaceState>) {
  state = workspaceState({ ...state, ...patch });
  render();
  void chrome.runtime.sendMessage({ type: 'WORKSPACE_PRESENTATION', patch });
}
function render() {
  if (!host) return;
  const changed = host.dataset.open !== undefined && host.dataset.open !== String(state.open);
  const shell = host.shadowRoot!.querySelector<HTMLElement>('.gi-shell')!;
  const pill = host.shadowRoot!.querySelector<HTMLElement>('.gi-pill')!;
  const pidgy = host.shadowRoot!.querySelector<HTMLElement>('.pidgy')!;
  // Capture the visible geometry before cancelling an interrupted transition.
  const before = shell.getBoundingClientRect(), birdBefore = pidgy.getBoundingClientRect();
  const geometry = JSON.stringify({ position:state.position, size:state.size });
  const geometryChanged = geometry !== lastGeometry;
  const displayChanged = host.dataset.display !== state.display;
  if (changed || geometryChanged || displayChanged) { motion.forEach((animation) => animation.cancel()); motion = []; }
  lastGeometry = geometry;
  host.dataset.open = String(state.open);
  host.dataset.display = state.display;
  pill.setAttribute('aria-expanded', String(state.open));
  const frame = host.shadowRoot!.querySelector('iframe')!;
  frame.inert = !state.open || state.display === 'dock';
  frame.tabIndex = frame.inert ? -1 : 0;
  shell.setAttribute('aria-label', state.open ? 'PigeonBox workspace' : 'Collapsed PigeonBox');
  if (changed || geometryChanged || displayChanged) placeFloat(host, { right: 24, top: 80 }, state);
  if (changed && state.display === 'float' && !prefersReducedMotion() && typeof shell.animate === 'function') {
    const after = shell.getBoundingClientRect(), birdAfter = pidgy.getBoundingClientRect();
    // Docked or hidden surfaces have no box to morph from. Apply their new
    // presentation without dividing by zero or emitting invalid keyframes.
    const measurable = [before, after].every((rect) => rect.width > 0 && rect.height > 0
      && [rect.width, rect.height, rect.right, rect.top].every(Number.isFinite));
    if (measurable) {
      const sx = before.width / after.width, sy = before.height / after.height;
      const radius = state.open ? 22 : 14;
      const options = motionOptions(shell, 'expressive');
      motion.push(shell.animate([
        { transform:`translate(${before.right - after.right}px,${before.top - after.top}px) scale(${sx},${sy})`, borderRadius:`${radius / sx}px / ${radius / sy}px` },
        { transform:'none', borderRadius:state.open ? getComputedStyle(shell).getPropertyValue('--pb-radius-shell') : '22px' },
      ], options));
      // This is the same Pidgy node on both surfaces; its pixels never stretch.
      motion.push(pidgy.animate([{ transform:`translate(${birdBefore.left - birdAfter.left}px,${birdBefore.top - birdAfter.top}px)` }, { transform:'none' }], options));
      if (state.open) {
        const header = shell.querySelector('header')!;
        const timing = motionOptions(shell, 'standard');
        motion.push(header.animate([{ opacity:0 },{ opacity:1 }], { ...timing, delay:60, fill:'backwards' }));
        motion.push(frame.animate([{ opacity:0 },{ opacity:1 }], { ...timing, delay:100, fill:'backwards' }));
      } else {
        motion.push(pill.animate([{ opacity:0 },{ opacity:1 }], { ...motionOptions(shell,'quick'), delay:100, fill:'backwards' }));
      }
    }
  }
  if (changed && !state.open) {
    if (restoreFocus?.isConnected && restoreFocus !== host && restoreFocus !== frame) restoreFocus.focus({ preventScroll: true });
    else pill.focus({ preventScroll: true });
  }
}
export function showFloatingWorkspace(open: boolean, focus = false) {
  ensureWorkspace();
  if (open && focus) restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  persist({ open, display: 'float' });
  if (focus) host?.shadowRoot?.querySelector<HTMLElement>(open ? 'iframe' : '.gi-pill')?.focus();
}
export function updateFloatingWorkspace(value: unknown) { state = workspaceState(value); render(); }
export function ensureWorkspace() {
  if (host?.isConnected) return host;
  host = document.createElement('aside');
  host.id = 'pigeonbox-workspace';
  host.setAttribute('aria-label', 'PigeonBox workspace');
  host.setAttribute('data-gi-ui', 'workspace');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style'); style.textContent = CSS; shadow.append(style);
  const shell = document.createElement('div'); shell.className = 'gi-shell';
  const header = document.createElement('header'); header.dataset.giDrag = ''; header.tabIndex = 0;
  header.setAttribute('aria-label', 'Move PigeonBox with arrow keys; Shift and arrows resize; Home resets');
  const label = document.createElement('span'); label.textContent = 'PigeonBox'; header.append(label);
  const collapse = document.createElement('button'); collapse.type = 'button'; collapse.textContent = '−'; collapse.setAttribute('aria-label', 'Collapse PigeonBox'); collapse.onclick = () => showFloatingWorkspace(false); header.append(collapse);
  const frame = document.createElement('iframe'); frame.src = chrome.runtime.getURL('workspace.html'); frame.title = 'PigeonBox';
  shell.append(header, frame);
  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow || event.origin !== new URL(frame.src).origin) return;
    if (event.data?.type === 'PB_APPEARANCE') { if (host) applyTheme(host, normalizeAppearance(event.data.appearance)); return; }
    if (event.data?.type !== 'PB_VISUAL_STATE') return;
    const visual = String(event.data.state);
    const row = visual === 'thinking' ? 1 : visual === 'drafting' || visual === 'ready' ? 2 : 0;
    const image = host?.shadowRoot?.querySelector<HTMLElement>('.pidgy');
    if (image) { image.dataset.state = visual; image.style.backgroundPositionY = `${-row * 24}px`; }
  });
  const resize = document.createElement('button'); resize.type = 'button'; resize.className = 'gi-resize'; resize.dataset.giResize = ''; resize.setAttribute('aria-label', 'Resize PigeonBox with arrow keys'); shell.append(resize);
  const pill = document.createElement('button'); pill.type = 'button'; pill.className = 'gi-pill'; pill.dataset.giDrag = ''; pill.setAttribute('aria-label', 'Reopen PigeonBox'); pill.setAttribute('aria-expanded', 'false');
  const image = document.createElement('span'); image.className = 'pidgy'; image.setAttribute('aria-hidden', 'true'); image.style.backgroundImage = `url("${chrome.runtime.getURL('brand/pigeon-sprites.webp')}")`;
  const text = document.createElement('span'); text.textContent = 'PigeonBox'; pill.append(text); pill.onclick = () => showFloatingWorkspace(true, true);
  shadow.append(shell, pill, image);
  document.body.append(host);
  watchAppearance((appearance) => { if (host) applyTheme(host, appearance); });
  installFloatDrag(host, () => ({ right: 24, top: 80 }), { geometry: () => state, save: (geometry) => persist(geometry) });
  render();
  void chrome.runtime.sendMessage({ type: 'GET_WORKSPACE_PRESENTATION' }).then((result) => {
    if (!result?.state) return;
    updateFloatingWorkspace(result.state);
    // Move only legacy presentation geometry into extension-owned state.
    if (!state.position && !state.size) {
      try {
        const position = JSON.parse(localStorage.getItem('gi.float.pos') || 'null');
        const size = JSON.parse(localStorage.getItem('gi.float.size') || 'null');
        if (position || size) persist({ position: position || undefined, size: size || undefined });
      } catch { /* Malformed old geometry uses the bounded default. */ }
    }
  });
  return host;
}

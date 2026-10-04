import pigeonCss from '../../ui/pigeon.css?inline';
import productTokens from '../../ui/product-tokens.css?inline';
import systemCSS from '../../ui/system.css?inline';
import orbCss from '../../ui/orb.css?inline';

/** Injected into Gmail. Every selector is namespaced so it cannot restyle the host page. */
export const SURFACE_CSS = `${productTokens}
${pigeonCss}
${orbCss}

:host {
  display: inline-block;
  width: max-content;
  max-width: calc(100vw - 24px);
  overflow: visible;
  scrollbar-width: none;
}
:host([data-gi-ui="thread-sidebar"]) {
  display: block;
  width: 100%;
  max-width: 100%;
}
#gi-mount {
  all: initial;
  display: block;
  font: var(--pb-size-secondary)/1.45 ui-sans-serif, system-ui, sans-serif;
  color: var(--pb-fg);
  -webkit-font-smoothing: antialiased;
}
#gi-mount p { margin: 0; }

.gi-shell, .gi-pill {
  transform-origin: top right;
  transition: opacity var(--pb-motion-standard) cubic-bezier(0.23, 1, 0.32, 1), transform var(--pb-motion-standard) cubic-bezier(0.23, 1, 0.32, 1);
}
.gi-shell {
  box-sizing: border-box;
  width: 308px;
  max-height: calc(100vh - 96px);
  padding: var(--pb-space-1);
  border-radius: var(--pb-radius);
  background: var(--pb-surface-inset);
  box-shadow: none;
}
.gi-shell[data-variant="sidebar"] { width: 100%; }
.gi-core {
  max-height: calc(100vh - 112px);
  overflow: auto;
  border-radius: var(--pb-radius);
  padding: var(--pb-space-4);
  background: var(--pb-ink-2);
  box-shadow: none;
  scrollbar-width: none;
}
.gi-shell { overflow: hidden; scrollbar-width: none; }
.gi-brand { display: flex; align-items: center; gap: var(--pb-space-2); min-width: 0; }
.gi-mark {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  border-radius: var(--pb-radius-sm);
  background: var(--pb-ink-2);
  box-shadow: none;
}
.gi-kicker {
  font-size: var(--pb-size-meta);
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--pb-fg-muted);
}
.gi-hide {
  appearance: none;
  border: 0;
  border-radius: var(--pb-radius-xs);
  background: transparent;
  color: var(--pb-fg-muted);
  padding: var(--pb-space-1) var(--pb-space-2);
  font: 600 var(--pb-size-meta)/1 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  transition: transform var(--pb-motion-quick) cubic-bezier(0.23, 1, 0.32, 1), color var(--pb-motion-standard) ease, background var(--pb-motion-standard) ease;
}
.gi-hide:active { transform: translateY(1px); }
.gi-hide:focus-visible { outline: 2px solid var(--pb-accent); outline-offset: 2px; }
.gi-icon {
  appearance: none;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--pb-radius-xs);
  padding: 0;
  background: transparent;
  color: var(--pb-fg-muted);
  cursor: pointer;
  transition: transform var(--pb-motion-quick) cubic-bezier(0.23, 1, 0.32, 1), background var(--pb-motion-standard) ease, color var(--pb-motion-standard) ease;
}
.gi-icon:active { transform: translateY(1px); }
.gi-thread-mascot { display: flex; align-items: center; gap: var(--pb-space-2); margin: var(--pb-space-3) 0; padding: var(--pb-space-2); border-radius: var(--pb-radius); background: var(--pb-surface-inset); }
.gi-thread-mascot strong { display:block; font-size:var(--pb-size-body); font-weight:500; color:var(--pb-fg); }
.gi-thread-mascot small { display:block; margin-top:var(--pb-space-1); color:var(--pb-fg-muted); font-size:var(--pb-size-meta); }
.gi-catrow { display: flex; align-items: center; gap: var(--pb-space-2); margin-top: var(--pb-space-2); }
.gi-cat {
  font-size: var(--pb-size-body);
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 1.15;
  color: var(--pb-fg);
}
.gi-you { color: var(--pb-fg-muted); font-size: var(--pb-size-meta); }
.gi-section { margin-top: var(--pb-space-4); padding-top: var(--pb-space-1); border-top: 1px solid var(--pb-surface-inset); }
.gi-section-heading { margin-top: var(--pb-space-3); color: var(--pb-fg-muted); font-size: var(--pb-size-meta); font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.gi-cloud-state { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--pb-space-1) var(--pb-space-2); margin-top: var(--pb-space-2); }
.gi-cloud-state strong { color: var(--pb-fg); font-size: var(--pb-size-secondary); font-weight: 600; }
.gi-cloud-state span { color: var(--pb-copper-bright); font-size: var(--pb-size-label); }
.gi-cloud-why { margin-top: var(--pb-space-1); color: var(--pb-fg-muted); font-size: var(--pb-size-label); line-height: 1.45; }
.gi-cloud-warn { margin-top: var(--pb-space-2); padding: var(--pb-space-2) var(--pb-space-2); border-radius: var(--pb-radius); background: var(--pb-accent-soft); color: var(--pb-copper-bright); font-size: var(--pb-size-meta); line-height: 1.45; }
.gi-cloud-draft { margin-top: var(--pb-space-2); padding: var(--pb-space-2); border-radius: var(--pb-radius); background: var(--pb-surface-inset); color: var(--pb-fg); font-size: var(--pb-size-label); line-height: 1.55; white-space: pre-wrap; user-select: text; }
.gi-cloud-draft mark { background: var(--pb-accent-soft); color: var(--pb-accent); border-radius: var(--pb-radius-xs); padding: 0 2px; }
.gi-cloud-sources { margin-top: var(--pb-space-1); color: var(--pb-fg-muted); font-size: var(--pb-size-meta); line-height: 1.4; }
.gi-cloud-variants { display: flex; gap: var(--pb-space-1); margin-top: var(--pb-space-2); }
.gi-cloud-variant { appearance: none; border: 1px solid var(--pb-surface-inset); background: transparent; color: var(--pb-fg-muted); border-radius: var(--pb-radius-xs); padding: var(--pb-space-1) var(--pb-space-2); font-size: var(--pb-size-meta); cursor: pointer; }
.gi-cloud-variant.is-on { background: var(--pb-fg); color: var(--pb-surface); border-color: var(--pb-fg); }
.gi-cloud-variant:focus-visible { outline: 2px solid var(--pb-accent); outline-offset: 2px; }
.gi-sum { margin-top: var(--pb-space-2); color: var(--pb-fg); font-size: var(--pb-size-secondary); line-height: 1.5; user-select: text; }
.gi-sum.is-wait { color: var(--pb-fg-muted); }
.gi-retry-row { display: flex; align-items: flex-start; gap: var(--pb-space-2); margin-top: var(--pb-space-2); color: var(--pb-error); font-size: var(--pb-size-meta); line-height: 1.4; }
.gi-retry-row span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.gi-retry-row .gi-action { padding: var(--pb-space-1) var(--pb-space-2); font-size: var(--pb-size-meta); }
.gi-open { margin-top: var(--pb-space-3); }
.gi-open-label {
  font-size: var(--pb-size-meta);
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--pb-fg-muted);
}
.gi-open-label.is-open { color: var(--pb-copper-bright); }
.gi-open-line { margin-top: var(--pb-space-1); color: var(--pb-fg); font-size: var(--pb-size-secondary); line-height: 1.4; }
.gi-open-sub { margin-top: var(--pb-space-1); color: var(--pb-fg-muted); font-size: var(--pb-size-label); line-height: 1.4; }
.gi-open-count {
  margin-top: var(--pb-space-2);
  border-radius: var(--pb-radius);
  text-align: center;
  font-weight: 600;
  font-size: var(--pb-size-label);
  letter-spacing: -0.01em;
  padding: var(--pb-space-2) var(--pb-space-2);
  background: var(--pb-surface-inset);
  color: var(--pb-fg);
  box-shadow: none;
}
.gi-open-count.is-open {
  background: var(--pb-accent-soft);
  color: var(--pb-accent);
  box-shadow: none;
}
.gi-actions { display: flex; flex-wrap: wrap; gap: var(--pb-space-2); margin-top: var(--pb-space-3); }
.gi-action {
  appearance: none;
  border: 0;
  border-radius: var(--pb-radius-xs);
  padding: var(--pb-space-2) var(--pb-space-3);
  background:var(--pb-copper-bright);
  color: var(--pb-on-accent);
  font: 600 var(--pb-size-label)/1 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: -0.01em;
  cursor: pointer;
  transition: transform var(--pb-motion-quick) cubic-bezier(0.23, 1, 0.32, 1), background var(--pb-motion-standard) ease;
}
.gi-action:active { transform: translateY(1px); }
.gi-action:disabled { opacity: 0.65; cursor: default; }
.gi-action.is-ghost {
  background: transparent;
  color: var(--pb-fg);
  box-shadow: none;
}
.gi-points {
  margin: var(--pb-space-2) 0 0;
  padding: 0;
  list-style: none;
}
.gi-points li {
  position: relative;
  margin: 0;
  padding: var(--pb-space-1) 0 var(--pb-space-1) var(--pb-space-3);
  color: var(--pb-fg);
  font-size: var(--pb-size-secondary);
  line-height: 1.45;
}
.gi-points li::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0.62em;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background:var(--pb-copper-bright);
}
.gi-dates { display: flex; flex-wrap: wrap; gap: var(--pb-space-1); margin-top: var(--pb-space-2); }
.gi-date {
  border-radius: var(--pb-radius-xs);
  padding: var(--pb-space-1) var(--pb-space-2);
  color: var(--pb-accent);
  background: var(--pb-accent-soft);
  font-size: var(--pb-size-meta);
  font-weight: 600;
}


.gi-toast-wrap {
  display: flex;
  justify-content: center;
  width: 100%;
  pointer-events: none;
}
.gi-toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: var(--pb-space-3);
  max-width: min(420px, calc(100vw - 32px));
  padding: var(--pb-space-2) var(--pb-space-3);
  border-radius: var(--pb-radius-xs);
  background: var(--pb-surface-raised);
  color: var(--pb-fg);
  border: 1px solid var(--pb-surface-inset);
  box-shadow: none;
  font: var(--pb-size-secondary)/1.35 ui-sans-serif, system-ui, sans-serif;
  transition: opacity var(--pb-motion-standard) cubic-bezier(0.23, 1, 0.32, 1), transform var(--pb-motion-standard) cubic-bezier(0.23, 1, 0.32, 1);
}
.gi-toast-retry {
  border: 0;
  background: transparent;
  color: var(--pb-copper-bright);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
}
.gi-toast-retry:active { transform: translateY(1px); }

.gi-cat-chip {
  display: inline-flex !important;
  align-items: center !important;
  margin: 0 0 0 var(--pb-space-2) !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  color: #935023 !important;
  font: 600 var(--pb-size-meta)/1 ui-sans-serif, system-ui, sans-serif !important;
  letter-spacing: -0.01em !important;
  vertical-align: middle !important;
  white-space: nowrap !important;
}
.gi-cat-chip[data-category="WAITING"] { color: #8d6b1f !important; }
.gi-cat-chip[data-category="FYI"] { color: #5f6b7a !important; }
.gi-cat-chip[data-category="NOTIFICATIONS"] { color: #3d6fbf !important; }
.gi-cat-chip[data-category="PROMOTIONS"] { color: #a14d6c !important; }
.gi-cat-chip[data-category="NEWS"] { color: #2f7a56 !important; }
.gi-cat-chip[data-category="PRIORITY"], .gi-cat-chip[data-category="FOLLOW_UPS"] { color: #8d4b16 !important; }

.gi-track-slot { display: inline-flex !important; align-items: center; margin: 0 var(--pb-space-2) 0 0; vertical-align: middle; flex: 0 0 auto; min-width: 16px; line-height: 0; overflow: visible; }
.gi-track-message-slot { margin: 0 0 0 6px; }
.gi-track-btn { display: inline-flex; align-items: center; gap: var(--pb-space-1); cursor: pointer; }
.gi-track-btn[data-state="opened"] { color: #935023 !important; }
.gi-track-btn[data-state="pending"] { color: #80868b !important; }
.gi-track-label, .gi-track-n { font: 600 var(--pb-size-label)/1 ui-sans-serif, system-ui, sans-serif; }
.gi-track-backdrop { position: fixed; inset: 0; z-index: 2147483645; background: transparent; }
.gi-track-card {
  position: fixed;
  z-index: 2147483646;
  box-sizing: border-box;
  width: 340px;
  padding: var(--pb-space-4) var(--pb-space-4) var(--pb-space-3);
  border-radius: var(--pb-radius);
  background: var(--pb-surface-raised) !important;
  color: var(--pb-fg) !important;
  border: 1px solid var(--pb-surface-inset) !important;
  box-shadow: none;
  font: var(--pb-size-body)/1.4 ui-sans-serif, system-ui, sans-serif !important;
}
.gi-track-headline { margin: 0; color: var(--pb-fg) !important; }
.gi-track-headline strong { font-weight: 600; }
.gi-track-detail { display: flex; align-items: flex-start; gap: var(--pb-space-2); margin: var(--pb-space-2) 0 0; color: var(--pb-fg-muted) !important; font-size: var(--pb-size-secondary); }
.gi-track-detail svg { flex: 0 0 auto; margin-top: 1px; }
.gi-track-count {
  margin-top: var(--pb-space-3);
  border-radius: var(--pb-radius);
  background: var(--pb-surface-inset) !important;
  color: var(--pb-fg) !important;
  text-align: center;
  font-weight: 600;
  padding: var(--pb-space-2) var(--pb-space-3);
}
.gi-track-count.is-open {
  background: var(--pb-accent-soft) !important;
  color: var(--pb-accent) !important;
  box-shadow: none;
}
.gi-track-warning { margin: var(--pb-space-2) 0 0; color: var(--pb-warning-color) !important; font-size: var(--pb-size-label); line-height: 1.4; }
.gi-track-note { margin: var(--pb-space-2) 0 0; color: var(--pb-fg-muted) !important; font-size: var(--pb-size-label); line-height: 1.4; }
.gi-track-activity { margin: var(--pb-space-3) 0 0; padding: 0; list-style: none; }
.gi-track-activity li { display: grid; grid-template-columns: 6.5em 1fr; gap: var(--pb-space-2); padding: var(--pb-space-1) 0; color: var(--pb-fg) !important; font-size: var(--pb-size-label); line-height: 1.35; }
.gi-track-activity time { color: var(--pb-fg-muted) !important; font-variant-numeric: tabular-nums; white-space: nowrap; }
.gi-track-activity span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gi-track-activity .is-more { color: var(--pb-fg-muted) !important; }
.gi-track-footer {
  display: flex;
  align-items: center;
  gap: var(--pb-space-2);
  margin-top: var(--pb-space-3);
  padding-top: var(--pb-space-3);
  border-top:1px solid var(--pb-ink-rule);
  background-size: 100% 1px;
  background-repeat: no-repeat;
}
.gi-track-notify { color: var(--pb-fg) !important; font-size: var(--pb-size-secondary); }
.gi-switch {
  position: relative;
  width: 36px;
  height: 22px;
  flex: 0 0 auto;
  border: 0;
  border-radius: var(--pb-radius-xs);
  background: var(--pb-surface-inset);
  padding: 0;
  cursor: pointer;
}
.gi-switch[aria-checked="true"] { background:var(--pb-copper-bright); }
.gi-switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--pb-fg);
  transition: transform var(--pb-motion-standard) cubic-bezier(0.23, 1, 0.32, 1);
}
.gi-switch[aria-checked="true"] .gi-switch-knob { transform: translateX(14px); }
.gi-switch:active { transform: translateY(1px); }
.gi-track-arrow {
  position: absolute;
  width: 12px;
  height: 12px;
  background: var(--pb-surface-raised) !important;
  transform: translateX(-50%) rotate(45deg);
}
.gi-track-card[data-placement="above"] .gi-track-arrow { bottom: -6px; }
.gi-track-card[data-placement="below"] .gi-track-arrow { top: -6px; }

.gi-menu {
  position: fixed;
  z-index: 2147483646;
  min-width: 196px;
  padding: var(--pb-space-1);
  border-radius: var(--pb-radius);
  background: var(--pb-surface-raised) !important;
  color: var(--pb-fg) !important;
  color-scheme: dark;
  border: 1px solid var(--pb-surface-inset) !important;
  box-shadow: none;
  font: var(--pb-size-secondary)/1.4 ui-sans-serif, system-ui, sans-serif !important;
}
.gi-menu-row {
  display: flex;
  gap: var(--pb-space-2);
  align-items: center;
  padding: var(--pb-space-2) var(--pb-space-2);
  border-radius: var(--pb-radius);
  cursor: pointer;
  color: var(--pb-fg) !important;
}
.gi-compose-tracking-bar { display: flex; align-items: center; box-sizing: border-box; min-height: 36px; max-width: 100%; padding: 0 8px; }
.gi-compose-tracking-bar .gi-compose-track { margin: 0 !important; padding: 5px 10px !important; }
.gi-compose-track {
  display: inline-flex !important;
  align-items: center !important;
  vertical-align: middle !important;
  white-space: nowrap !important;
  gap: 7px !important;
  margin: 0 var(--pb-space-2) 0 0 !important;
  border: 1px solid var(--pb-border-strong, #b5c1bc) !important;
  border-radius: var(--pb-radius-pill, 999px) !important;
  background: transparent !important;
  color: var(--pb-fg-muted, #64717b) !important;
  font: 600 var(--pb-size-label)/1 var(--pb-sans, ui-sans-serif, system-ui, sans-serif) !important;
  letter-spacing: var(--pb-tracking-label, .01em) !important;
  cursor: pointer !important;
  padding: 8px 14px 8px 10px !important;
  transition: background .2s ease, border-color .2s ease, box-shadow .2s ease, transform .12s ease;
}
.gi-compose-track::before {
  content: "";
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  background: currentColor;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.6'%3E%3Ccircle cx='8' cy='8' r='6.2'/%3E%3C/svg%3E") center / contain no-repeat;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.6'%3E%3Ccircle cx='8' cy='8' r='6.2'/%3E%3C/svg%3E") center / contain no-repeat;
}
.gi-compose-track { position: relative !important; overflow: hidden !important; }
.gi-compose-track[data-tone="preparing"] {
  color: var(--pb-tracking, #496775) !important;
  border-color: color-mix(in srgb, var(--pb-tracking, #496775) 45%, transparent) !important;
  animation: pb-track-breathe 2.4s ease-in-out infinite;
}
/* The real thinking orb (injected by compose-tracking) replaces the static ring glyph. */
.gi-compose-track[data-tone="preparing"]::before { display: none; }
.gi-compose-track[data-tone="preparing"] { padding-left: 9px !important; }
.gi-compose-track .gi-orb { font-size: 26px !important; margin: -5px 0 -5px 0; color: var(--pb-tracking, #496775); filter: drop-shadow(0 0 5px color-mix(in srgb, var(--pb-tracking, #496775) 45%, transparent)); }
@keyframes pb-track-breathe { 0%, 100% { box-shadow: 0 0 0 0 transparent; } 50% { box-shadow: 0 0 10px color-mix(in srgb, var(--pb-tracking, #496775) 28%, transparent); } }
@media (prefers-reduced-motion: reduce) {
  .gi-compose-track[data-tone="preparing"] { animation: none !important; }
}
.gi-compose-track[data-on="1"] {
  color: var(--pb-accent, #9a4b2e) !important;
  border-color: color-mix(in srgb, var(--pb-accent, #9a4b2e) 45%, transparent) !important;
  background: linear-gradient(135deg, color-mix(in srgb, var(--pb-accent, #9a4b2e) 20%, transparent), color-mix(in srgb, var(--pb-accent, #9a4b2e) 6%, transparent)) !important;
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--pb-accent, #9a4b2e) 18%, transparent), 0 1px 2px color-mix(in srgb, var(--pb-accent, #9a4b2e) 18%, transparent) !important;
}
.gi-compose-track[data-on="1"]::before {
  -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='8' cy='8' r='6.2'/%3E%3Cpath d='M5.2 8.2l2 2 3.6-4'/%3E%3C/svg%3E");
  mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='8' cy='8' r='6.2'/%3E%3Cpath d='M5.2 8.2l2 2 3.6-4'/%3E%3C/svg%3E");
}
/* Hovering the badge or anywhere in the Send group lifts the badge onto an opaque themed fill so the copper text stays legible over Gmail's blue. */
.gi-compose-track[data-on="1"]:hover,
:has(> :not(.gi-compose-track):hover) > .gi-compose-track[data-on="1"] {
  background: color-mix(in srgb, var(--pb-accent, #9a4b2e) 16%, var(--pb-surface-raised, #fff)) !important;
  border-color: var(--pb-accent, #9a4b2e) !important;
  box-shadow: 0 2px 10px color-mix(in srgb, var(--pb-accent, #9a4b2e) 28%, transparent) !important;
}
.gi-compose-track:active { transform: translateY(1px); }

@media (hover: hover) and (pointer: fine) {
  .gi-icon:hover, .gi-hide:hover { background: var(--pb-surface-inset); color: var(--pb-fg); }
  .gi-action.is-ghost:hover { background: var(--pb-surface-inset); }
  .gi-menu-row:hover { background: var(--pb-surface-inset); }
}
.gi-cloud-context { border-top:1px solid var(--pb-surface-inset); margin-top:var(--pb-space-3); padding-top:var(--pb-space-2); font-size:var(--pb-size-label); }
.gi-cloud-context summary { cursor:pointer; color:var(--pb-accent); padding:var(--pb-space-1) 0; }
.gi-cloud-context summary:focus-visible { outline:2px solid var(--pb-accent); outline-offset:3px; }
.gi-cloud-next { border-left:2px solid var(--pb-accent); padding:var(--pb-space-2) var(--pb-space-3); margin:var(--pb-space-3) 0; background:var(--pb-accent-soft); }
@media (prefers-reduced-motion:no-preference) { .gi-cloud-draft { animation:gi-prepared var(--pb-motion-standard) ease-out both; } }
@keyframes gi-prepared { from { opacity:0; transform:translateY(3px); } to { opacity:1; transform:none; } }

@media (prefers-reduced-motion: reduce) {
  .gi-shell, .gi-pill, .gi-toast, .gi-action, .gi-icon, .gi-switch-knob {
    animation: none;
    transition: opacity var(--pb-motion-quick) ease;
  }
  .gi-dot.is-live { animation: none; }
}
@media (prefers-reduced-transparency: reduce) {
  .gi-shell, .gi-pill, .gi-toast, .gi-track-card, .gi-menu {
    background: var(--pb-surface-raised) !important;
  }
  .gi-core { background: var(--pb-surface-inset); }
}

/* The floating companion is a real elevated surface; all internal sections use rules. */
#gi-mount { font-family:var(--pb-sans); color:var(--pb-ink-text); }
.gi-shell { padding:0; border:1px solid var(--pb-ink-rule); background:var(--pb-ink-2); box-shadow:var(--pb-shadow-float); }
.gi-core { background:var(--pb-ink-2); padding:var(--pb-space-3); }
.gi-bar { padding-bottom:var(--pb-space-2); border-bottom:1px solid var(--pb-ink-rule); }
.gi-kicker, .gi-section-heading, .gi-cat { font-family:var(--pb-mono); letter-spacing:.1em; color:var(--pb-pigeon); }
.gi-cat { font-size:var(--pb-size-meta); text-transform:uppercase; }
.gi-thread-mascot { background:transparent; border-radius:0; margin:var(--pb-space-2) 0; padding:0; }
.gi-thread-mascot strong { font:var(--pb-size-label) var(--pb-sans); }.gi-thread-mascot small { font:var(--pb-size-meta) var(--pb-mono); text-transform:uppercase; color:var(--pb-pigeon); }
.gi-sum { font:var(--pb-size-title)/1.5 var(--pb-serif); color:var(--pb-ink-text); }
.gi-sum.is-wait { font:var(--pb-size-label)/1.5 var(--pb-sans); color:var(--pb-ink-muted); }
.gi-actions { display:grid; gap:0; margin-top:var(--pb-space-4); }
.gi-action { display:flex; align-items:center; justify-content:space-between; min-height:40px; width:100%; border:0; border-top:1px solid var(--pb-ink-rule); border-radius:0; padding:var(--pb-space-2) 0; background:transparent; color:var(--pb-copper-bright); text-align:left; font:500 var(--pb-size-label) var(--pb-sans); }
.gi-action.is-ghost { color:var(--pb-ink-text); background:transparent; box-shadow:none; }
.gi-pill { border:1px solid var(--pb-ink-rule); background:var(--pb-ink-2); box-shadow:var(--pb-shadow-low); }
.gi-section, .gi-open { border-top:1px solid var(--pb-ink-rule); padding-top:var(--pb-space-2); }
.gi-date { border-radius:var(--pb-radius-xs); font-family:var(--pb-mono); }
.pb-route-line { width:100%; height:10px; color:var(--pb-copper-bright); }.pb-route-line path { stroke-dasharray:100; }
@media(prefers-reduced-motion:no-preference) { .gi-sum:not(.is-wait) { animation:pb-brief-arrive var(--pb-motion-expressive) cubic-bezier(.22,1,.36,1) both; }.pb-route-line path { animation:pb-route-draw var(--pb-motion-expressive) cubic-bezier(.22,1,.36,1) both; } }
@keyframes pb-brief-arrive { from { opacity:0;transform:translateY(3px);clip-path:inset(0 0 100%); } to { opacity:1;transform:none;clip-path:inset(0); } }
@keyframes pb-route-draw { 0% { stroke-dashoffset:100;opacity:0; } 20%,80% { opacity:1; } 100% { stroke-dashoffset:0;opacity:0; } }
${systemCSS}

`;

export function ensureSurface(): void {
  let style = document.getElementById('gi-surface') as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = 'gi-surface';
    document.documentElement.append(style);
  }
  if (style.textContent !== SURFACE_CSS) style.textContent = SURFACE_CSS;
}

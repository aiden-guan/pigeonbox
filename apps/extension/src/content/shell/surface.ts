import pigeonCss from '../../ui/pigeon.css?inline';
import productTokens from '../../ui/product-tokens.css?inline';
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
#gi-thread-panel {
  position: fixed !important;
  top: 72px !important;
  right: 16px !important;
  z-index: 2147483000 !important;
  display: block !important;
  width: max-content !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  box-shadow: none;
  overflow: visible !important;
  scrollbar-width: none !important;
}
:host::-webkit-scrollbar,
#gi-thread-panel::-webkit-scrollbar,
.gi-shell::-webkit-scrollbar,
.gi-core::-webkit-scrollbar {
  width: 0 !important;
  height: 0 !important;
  display: none !important;
}
#gi-mount {
  all: initial;
  display: block;
  font: 13px/1.45 ui-sans-serif, system-ui, sans-serif;
  color: #f4f0e8;
  -webkit-font-smoothing: antialiased;
}
#gi-mount p { margin: 0; }

.gi-shell, .gi-pill {
  transform-origin: top right;
  transition: opacity 200ms cubic-bezier(0.23, 1, 0.32, 1), transform 200ms cubic-bezier(0.23, 1, 0.32, 1);
}
.gi-shell {
  box-sizing: border-box;
  width: 308px;
  max-height: calc(100vh - 96px);
  padding: 4px;
  border-radius: var(--pb-radius);
  background: rgba(255, 255, 255, 0.06);
  box-shadow: none;
}
.gi-shell[data-variant="sidebar"] { width: 100%; }
.gi-shell {
  @starting-style {
    opacity: 0;
    transform: translateY(-4px) scale(0.98);
  }
}
.gi-core {
  max-height: calc(100vh - 112px);
  overflow: auto;
  border-radius: var(--pb-radius);
  padding: 16px;
  background: var(--pb-ink-2);
  box-shadow: none;
  scrollbar-width: none;
}
.gi-shell { overflow: hidden; scrollbar-width: none; }
.gi-shell[data-variant="float"] {
  position: relative;
  display: flex;
  flex-direction: column;
  width: var(--gi-w, 308px);
  height: var(--gi-h, auto);
  max-height: calc(100vh - 16px);
}
.gi-shell[data-variant="float"] > .gi-core { flex: 1 1 auto; min-height: 0; max-height: none; }
[data-gi-drag] { cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none; }
[data-gi-drag] button { cursor: pointer; }
:host([data-gi-dragging]) .gi-shell,
:host([data-gi-dragging]) .gi-pill { transition: none; }
:host([data-gi-dragging]) [data-gi-drag] { cursor: grabbing; }
:host([data-gi-dragging]) .gi-pill:active { transform: none; }
.gi-resize {
  position: absolute;
  left: 3px;
  bottom: 3px;
  width: 16px;
  height: 16px;
  cursor: nesw-resize;
  touch-action: none;
  opacity: 0;
  transition: opacity 160ms ease;
}
.gi-resize::after {
  content: '';
  position: absolute;
  left: 4px;
  bottom: 4px;
  width: 7px;
  height: 7px;
  border-left: 2px solid rgba(244, 240, 232, 0.5);
  border-bottom: 2px solid rgba(244, 240, 232, 0.5);
  border-bottom-left-radius: 6px;
}
.gi-shell:hover .gi-resize, :host([data-gi-dragging]) .gi-resize { opacity: 1; }
.gi-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.gi-brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.gi-mark {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  border-radius: 5px;
  background: var(--pb-ink-2);
  box-shadow: none;
}
.gi-kicker {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #c4b7a6;
}
.gi-hide {
  appearance: none;
  border: 0;
  border-radius: var(--pb-radius-xs);
  background: transparent;
  color: #bcb9af;
  padding: 6px 8px;
  font: 600 11px/1 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1), color 160ms ease, background 160ms ease;
}
.gi-hide:active { transform: translateY(1px); }
.gi-hide:focus-visible { outline: 2px solid #edbb93; outline-offset: 2px; }
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
  color: #c9c5b9;
  cursor: pointer;
  transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1), background 160ms ease, color 160ms ease;
}
.gi-icon:active { transform: translateY(1px); }
.gi-thread-mascot { display: flex; align-items: center; gap: 8px; margin: 12px 0; padding: 8px; border-radius: var(--pb-radius); background: rgba(244,240,232,.035); }
.gi-thread-mascot strong { display:block; font-size:14px; font-weight:500; color:#f4f0e8; }
.gi-thread-mascot small { display:block; margin-top:4px; color:#aba99e; font-size:11px; }
.gi-catrow { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.gi-cat {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 1.15;
  color: #faf5eb;
}
.gi-you { color: #aba99e; font-size: 11px; }
.gi-section { margin-top: 16px; padding-top: 4px; border-top: 1px solid rgba(244,240,232,.08); }
.gi-section-heading { margin-top: 12px; color: #b4afa1; font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.gi-cloud-state { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin-top: 8px; }
.gi-cloud-state strong { color: #faf5eb; font-size: 13px; font-weight: 600; }
.gi-cloud-state span { color: var(--pb-copper-bright); font-size: 12px; }
.gi-cloud-why { margin-top: 6px; color: #aba99e; font-size: 12px; line-height: 1.45; }
.gi-cloud-warn { margin-top: 8px; padding: 7px 9px; border-radius: var(--pb-radius); background: rgba(237,187,147,.12); color: var(--pb-copper-bright); font-size: 11px; line-height: 1.45; }
.gi-cloud-draft { margin-top: 8px; padding: 10px; border-radius: var(--pb-radius); background: rgba(244,240,232,.05); color: #e8e4da; font-size: 12px; line-height: 1.55; white-space: pre-wrap; user-select: text; }
.gi-cloud-draft mark { background: rgba(237,187,147,.22); color: #f6d3b5; border-radius: 4px; padding: 0 2px; }
.gi-cloud-sources { margin-top: 6px; color: #8f8c82; font-size: 11px; line-height: 1.4; }
.gi-cloud-variants { display: flex; gap: 6px; margin-top: 8px; }
.gi-cloud-variant { appearance: none; border: 1px solid rgba(244,240,232,.14); background: transparent; color: #c9c5b9; border-radius: var(--pb-radius-xs); padding: 4px 10px; font-size: 11px; cursor: pointer; }
.gi-cloud-variant.is-on { background: #f4f0e8; color: #1b1a17; border-color: #f4f0e8; }
.gi-cloud-variant:focus-visible { outline: 2px solid #edbb93; outline-offset: 2px; }
.gi-sum { margin-top: 8px; color: #d2cfc5; font-size: 13px; line-height: 1.5; user-select: text; }
.gi-sum.is-wait { color: #aba99e; }
.gi-retry-row { display: flex; align-items: flex-start; gap: 8px; margin-top: 8px; color: #e8adb2; font-size: 11px; line-height: 1.4; }
.gi-retry-row span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.gi-retry-row .gi-action { padding: 5px 8px; font-size: 11px; }
.gi-open { margin-top: 12px; }
.gi-open-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #aba99e;
}
.gi-open-label.is-open { color: var(--pb-copper-bright); }
.gi-open-line { margin-top: 6px; color: #f4f0e8; font-size: 13px; line-height: 1.4; }
.gi-open-sub { margin-top: 4px; color: #aba99e; font-size: 12px; line-height: 1.4; }
.gi-open-count {
  margin-top: 10px;
  border-radius: var(--pb-radius);
  text-align: center;
  font-weight: 600;
  font-size: 12px;
  letter-spacing: -0.01em;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.05);
  color: #d2cfc5;
  box-shadow: none;
}
.gi-open-count.is-open {
  background: rgba(221, 167, 122, 0.16);
  color: #f5d9bf;
  box-shadow: none;
}
.gi-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.gi-action {
  appearance: none;
  border: 0;
  border-radius: var(--pb-radius-xs);
  padding: 8px 12px;
  background:var(--pb-copper-bright);
  color: #241c16;
  font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: -0.01em;
  cursor: pointer;
  transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1), background 160ms ease;
}
.gi-action:active { transform: translateY(1px); }
.gi-action:disabled { opacity: 0.65; cursor: default; }
.gi-action.is-ghost {
  background: transparent;
  color: #f4f0e8;
  box-shadow: none;
}
.gi-points {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}
.gi-points li {
  position: relative;
  margin: 0;
  padding: 3px 0 3px 12px;
  color: #eae5db;
  font-size: 13px;
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
.gi-dates { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.gi-date {
  border-radius: var(--pb-radius-xs);
  padding: 3px 8px;
  color: #f5d9bf;
  background: rgba(221, 167, 122, 0.16);
  font-size: 11px;
  font-weight: 600;
}
.gi-pill {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 12px 0 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: var(--pb-radius-xs);
  background: rgba(29, 29, 25, 0.9);
  color: #f4f0e8;
  box-shadow: none;
  cursor: pointer;
}
.gi-pill {
  @starting-style {
    opacity: 0;
    transform: translateY(-4px) scale(0.98);
  }
}
.gi-pill:active { transform: translateY(1px); }
.gi-pill .gi-mark { width: 22px; height: 22px; border-radius: var(--pb-radius-xs); }
.gi-pill-label { font-size: 12px; font-weight: 600; letter-spacing: -0.01em; }
.gi-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background:var(--pb-copper-bright);
  box-shadow: none;
}
.gi-dot.is-quiet { background: #79796e; box-shadow: none; }
.gi-dot.is-live { animation: gi-pulse 1.4s cubic-bezier(0.45, 0, 0.55, 1) infinite; }
@keyframes gi-pulse { 50% { opacity: 0.35; } }
.gi-pill:focus-visible, .gi-icon:focus-visible, .gi-action:focus-visible {
  outline: 2px solid #edbb93;
  outline-offset: 2px;
}

.gi-cmdk {
  position: absolute;
  inset: 0;
  display: flex;
  justify-content: center;
  padding-top: 14vh;
  background: rgba(21, 21, 18, 0.55);
  font: 14px/1.4 ui-sans-serif, system-ui, sans-serif;
  color: #f4f0e8;
}
.gi-cmdk-panel {
  width: min(520px, calc(100vw - 32px));
  height: max-content;
  padding: 5px;
  border-radius: var(--pb-radius);
  background: rgba(255, 255, 255, 0.06);
  box-shadow: none;
}
.gi-cmdk-core {
  border-radius: var(--pb-radius);
  overflow: hidden;
  background: var(--pb-ink-2);
  box-shadow: none;
}
.gi-cmdk-input {
  width: 100%;
  border: 0;
  outline: none;
  background: transparent;
  color: #f4f0e8;
  font: 500 16px/1.3 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: -0.02em;
  padding: 14px 14px 10px;
}
.gi-cmdk-input::placeholder { color: #a5a296; }
.gi-cmdk-list { max-height: 320px; overflow: auto; padding: 0 6px 4px; }
.gi-cmdk-row {
  display: flex;
  width: 100%;
  text-align: left;
  border: 0;
  border-radius: var(--pb-radius);
  padding: 9px 10px;
  background: transparent;
  color: #f4f0e8;
  font: 500 14px/1.3 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: -0.015em;
  cursor: pointer;
}
.gi-cmdk-row[data-active="true"] { background: rgba(221, 167, 122, 0.16); }
.gi-cmdk-row:active { transform: translateY(1px); }
.gi-cmdk-empty { padding: 12px; color: #aba99e; font-size: 13px; }
.gi-cmdk-foot {
  display: flex;
  gap: 14px;
  padding: 4px 12px 10px;
  color: #a5a296;
  font-size: 11px;
}
.gi-kbd {
  font-family: ui-monospace, monospace;
  font-size: 10px;
  color: #ded8cb;
  border-radius: 5px;
  padding: 1px 4px;
  margin-right: 4px;
  background: rgba(255, 255, 255, 0.06);
  box-shadow: none;
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
  gap: 14px;
  max-width: min(420px, calc(100vw - 32px));
  padding: 10px 14px;
  border-radius: var(--pb-radius-xs);
  background: #282822;
  color: #f4f0e8;
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: none;
  font: 13px/1.35 ui-sans-serif, system-ui, sans-serif;
  transition: opacity 180ms cubic-bezier(0.23, 1, 0.32, 1), transform 180ms cubic-bezier(0.23, 1, 0.32, 1);
}
.gi-toast {
  @starting-style {
    opacity: 0;
    transform: translateY(8px);
  }
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
  margin: 0 0 0 8px !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  color: #935023 !important;
  font: 600 11px/1 ui-sans-serif, system-ui, sans-serif !important;
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

.gi-track-slot { display: inline-flex !important; align-items: center; margin: 0 8px 0 0; vertical-align: middle; flex: 0 0 auto; min-width: 16px; line-height: 0; overflow: visible; }
.gi-track-btn { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.gi-track-btn[data-state="opened"] { color: #935023 !important; }
.gi-track-btn[data-state="pending"] { color: #80868b !important; }
.gi-track-label, .gi-track-n { font: 600 12px/1 ui-sans-serif, system-ui, sans-serif; }
.gi-track-backdrop { position: fixed; inset: 0; z-index: 2147483645; background: transparent; }
.gi-track-card {
  position: fixed;
  z-index: 2147483646;
  box-sizing: border-box;
  width: 340px;
  padding: 16px 16px 12px;
  border-radius: var(--pb-radius);
  background: #282822 !important;
  color: #f4f0e8 !important;
  border: 1px solid rgba(255, 255, 255, 0.1) !important;
  box-shadow: none;
  font: 14px/1.4 ui-sans-serif, system-ui, sans-serif !important;
}
.gi-track-headline { margin: 0; color: #f4f0e8 !important; }
.gi-track-headline strong { font-weight: 600; }
.gi-track-detail { display: flex; align-items: flex-start; gap: 8px; margin: 10px 0 0; color: #aba99e !important; font-size: 13px; }
.gi-track-detail svg { flex: 0 0 auto; margin-top: 1px; }
.gi-track-count {
  margin-top: 14px;
  border-radius: var(--pb-radius);
  background: rgba(255, 255, 255, 0.06) !important;
  color: #d2cfc5 !important;
  text-align: center;
  font-weight: 600;
  padding: 10px 12px;
}
.gi-track-count.is-open {
  background: rgba(221, 167, 122, 0.18) !important;
  color: #f5d9bf !important;
  box-shadow: none;
}
.gi-track-warning { margin: 10px 0 0; color: #e7c27a !important; font-size: 12px; line-height: 1.4; }
.gi-track-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  padding-top: 12px;
  border-top:1px solid var(--pb-ink-rule);
  background-size: 100% 1px;
  background-repeat: no-repeat;
}
.gi-track-notify { color: #eae5db !important; font-size: 13px; }
.gi-switch {
  position: relative;
  width: 36px;
  height: 22px;
  flex: 0 0 auto;
  border: 0;
  border-radius: var(--pb-radius-xs);
  background: rgba(255, 255, 255, 0.14);
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
  background: #fff;
  transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1);
}
.gi-switch[aria-checked="true"] .gi-switch-knob { transform: translateX(14px); }
.gi-switch:active { transform: translateY(1px); }
.gi-track-arrow {
  position: absolute;
  width: 12px;
  height: 12px;
  background: #282822 !important;
  transform: translateX(-50%) rotate(45deg);
}
.gi-track-card[data-placement="above"] .gi-track-arrow { bottom: -6px; }
.gi-track-card[data-placement="below"] .gi-track-arrow { top: -6px; }

.gi-menu {
  position: fixed;
  z-index: 2147483646;
  min-width: 196px;
  padding: 6px;
  border-radius: var(--pb-radius);
  background: #282822 !important;
  color: #f4f0e8 !important;
  color-scheme: dark;
  border: 1px solid rgba(255, 255, 255, 0.1) !important;
  box-shadow: none;
  font: 13px/1.4 ui-sans-serif, system-ui, sans-serif !important;
}
.gi-menu-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 7px 8px;
  border-radius: var(--pb-radius);
  cursor: pointer;
  color: #f4f0e8 !important;
}
.gi-compose-track {
  margin: 0 8px !important;
  border: 0 !important;
  border-radius: var(--pb-radius-xs) !important;
  background: transparent !important;
  color: #5f6368 !important;
  font: 600 12px/1 ui-sans-serif, system-ui, sans-serif !important;
  cursor: pointer !important;
  padding: 5px 8px !important;
}
.gi-compose-track[data-on="1"] {
  color: #78421e !important;
  background: rgba(221, 167, 122, 0.16) !important;
}
.gi-compose-track:active { transform: translateY(1px); }

@media (hover: hover) and (pointer: fine) {
  .gi-icon:hover, .gi-hide:hover { background: rgba(255, 255, 255, 0.06); color: #fff; }
  .gi-action.is-ghost:hover { background: rgba(255, 255, 255, 0.05); }
  .gi-cmdk-row:hover { background: rgba(255, 255, 255, 0.04); }
  .gi-cmdk-row[data-active="true"]:hover { background: rgba(221, 167, 122, 0.2); }
  .gi-menu-row:hover { background: rgba(255, 255, 255, 0.05); }
}
.gi-cloud-context { border-top:1px solid rgba(255,255,255,.08); margin-top:12px; padding-top:10px; font-size:12px; }
.gi-cloud-context summary { cursor:pointer; color:#dca77c; padding:6px 0; }
.gi-cloud-context summary:focus-visible { outline:2px solid #dca77c; outline-offset:3px; }
.gi-cloud-next { border-left:2px solid #dca77c; padding:8px 12px; margin:12px 0; background:rgba(220,167,124,.04); }
@media (prefers-reduced-motion:no-preference) { .gi-cloud-draft { animation:gi-prepared 200ms ease-out both; } .gi-cmdk-panel { animation:gi-prepared 140ms ease-out both; } }
@keyframes gi-prepared { from { opacity:0; transform:translateY(3px); } to { opacity:1; transform:none; } }

@media (prefers-reduced-motion: reduce) {
  .gi-shell, .gi-pill, .gi-toast, .gi-action, .gi-icon, .gi-switch-knob {
    animation: none;
    transition: opacity 120ms ease;
  }
  .gi-dot.is-live { animation: none; }
}
@media (prefers-reduced-transparency: reduce) {
  .gi-shell, .gi-pill, .gi-cmdk-panel, .gi-toast, .gi-track-card, .gi-menu {
    background: #292923 !important;
  }
  .gi-core, .gi-cmdk-core { background: #24241f; }
}

/* The floating companion is a real elevated surface; all internal sections use rules. */
#gi-mount { font-family:var(--pb-sans); color:var(--pb-ink-text); }
.gi-shell { padding:0; border:1px solid var(--pb-ink-rule); background:var(--pb-ink-2); box-shadow:0 8px 28px #0003; }
.gi-core { background:var(--pb-ink-2); padding:14px; }
.gi-bar { padding-bottom:10px; border-bottom:1px solid var(--pb-ink-rule); }
.gi-kicker, .gi-section-heading, .gi-cat { font-family:var(--pb-mono); letter-spacing:.1em; color:var(--pb-pigeon); }
.gi-cat { font-size:11px; text-transform:uppercase; }
.gi-thread-mascot { background:transparent; border-radius:0; margin:10px 0; padding:0; }
.gi-thread-mascot strong { font:12px var(--pb-sans); }.gi-thread-mascot small { font:9px var(--pb-mono); text-transform:uppercase; color:var(--pb-pigeon); }
.gi-sum { font:18px/1.5 var(--pb-serif); color:var(--pb-ink-text); }
.gi-sum.is-wait { font:12px/1.5 var(--pb-sans); color:var(--pb-ink-muted); }
.gi-actions { display:grid; gap:0; margin-top:16px; }
.gi-action { display:flex; align-items:center; justify-content:space-between; min-height:40px; width:100%; border:0; border-top:1px solid var(--pb-ink-rule); border-radius:0; padding:10px 0; background:transparent; color:var(--pb-copper-bright); text-align:left; font:500 12px var(--pb-sans); }
.gi-action.is-ghost { color:var(--pb-ink-text); background:transparent; box-shadow:none; }
.gi-pill { border:1px solid var(--pb-ink-rule); background:var(--pb-ink-2); box-shadow:0 4px 12px #0002; }
.gi-section, .gi-open { border-top:1px solid var(--pb-ink-rule); padding-top:10px; }
.gi-date { border-radius:3px; font-family:var(--pb-mono); }
.gi-cmdk-panel { border:1px solid var(--pb-copper-bright); border-radius:6px; background:var(--pb-ink-2); box-shadow:0 12px 30px #0003; padding:0; }
.gi-cmdk-core { border-radius:6px; background:var(--pb-ink-2); box-shadow:none; }
.gi-cmdk-input { border-radius:0; border-bottom:1px solid var(--pb-ink-rule); background:transparent; }
.gi-cmdk-row { border-radius:3px; }.gi-cmdk-row[data-active='true'] { border-left:2px solid var(--pb-copper-bright); background:var(--pb-ink-3); }
.pb-route-line { width:100%; height:10px; color:var(--pb-copper-bright); }.pb-route-line path { stroke-dasharray:100; }
@media(prefers-reduced-motion:no-preference) { .gi-sum:not(.is-wait) { animation:pb-brief-arrive 280ms cubic-bezier(.22,1,.36,1) both; }.pb-route-line path { animation:pb-route-draw 550ms cubic-bezier(.22,1,.36,1) both; } }
@keyframes pb-brief-arrive { from { opacity:0;transform:translateY(3px);clip-path:inset(0 0 100%); } to { opacity:1;transform:none;clip-path:inset(0); } }
@keyframes pb-route-draw { 0% { stroke-dashoffset:100;opacity:0; } 20%,80% { opacity:1; } 100% { stroke-dashoffset:0;opacity:0; } }
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

export function shadowMount(host: HTMLElement): HTMLElement {
  let shadow = host.shadowRoot;
  if (!shadow) {
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.dataset.giSurface = '1';
    style.textContent = SURFACE_CSS;
    const mount = document.createElement('div');
    mount.id = 'gi-mount';
    shadow.append(style, mount);
  } else {
    const style = shadow.querySelector('style');
    if (style && style.textContent !== SURFACE_CSS) style.textContent = SURFACE_CSS;
  }
  return shadow.querySelector('#gi-mount') as HTMLElement;
}

/** Keep the floating card to the left of the thread pane's scrollbar. */
export function floatPanelRightPx(viewportWidth: number, mainRight: number, scrollbarWidth: number): number {
  const gutter = Math.max(scrollbarWidth, 16);
  return Math.max(20, Math.round(viewportWidth - mainRight + gutter + 14));
}

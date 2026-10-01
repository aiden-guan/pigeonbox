import { SURFACE_CSS } from './surface';
import { trackProductEvent } from '../../ui/analytics';
export function mountCommandPalette(commandsFor: (filter: string) => readonly { id: string; label: string }[], run: (id: string) => void): void {
  if (document.querySelector('[data-gi-ui="cmdk"]')) return;
  trackProductEvent('command_palette_opened', { surface: 'gmail' });
  const previousFocus = document.activeElement as HTMLElement | null;
  const host = document.createElement('div');
  host.setAttribute('data-gi-ui', 'cmdk');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = SURFACE_CSS;
  const scrim = document.createElement('div');
  scrim.className = 'gi-cmdk';
  const panel = document.createElement('div');
  panel.className = 'gi-cmdk-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'PigeonBox commands');
  panel.setAttribute('aria-modal', 'true');
  const core = document.createElement('div');
  core.className = 'gi-cmdk-core';
  const input = document.createElement('input');
  input.className = 'gi-cmdk-input';
  input.placeholder = 'Search commands';
  input.setAttribute('aria-label', 'Search commands');
  const list = document.createElement('div');
  list.className = 'gi-cmdk-list';
  list.setAttribute('role', 'listbox');
  list.id = 'pigeon-command-list';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'true');
  const foot = document.createElement('div');
  foot.className = 'gi-cmdk-foot';
  foot.innerHTML = '<span><kbd class="gi-kbd">↑↓</kbd> move</span><span><kbd class="gi-kbd">↵</kbd> run</span><span><kbd class="gi-kbd">esc</kbd> close</span>';

  let active = 0;
  let items: HTMLButtonElement[] = [];

  const close = () => {
    window.removeEventListener('keydown', onWindowKey, true);
    host.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
  };
  const onWindowKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  const choose = (index: number) => {
    const id = items[index]?.dataset.command;
    if (!id) return;
    close();
    run(id);
  };
  const paintActive = (scroll = false) => {
    items.forEach((row, index) => {
      const on = index === active;
      row.dataset.active = on ? 'true' : 'false';
      row.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const selected = items[active];
    if (selected) input.setAttribute('aria-activedescendant', selected.id);
    else input.removeAttribute('aria-activedescendant');
    if (scroll) items[active]?.scrollIntoView({ block: 'nearest' });
  };
  const render = (filter: string) => {
    list.replaceChildren();
    items = [];
    const commands = commandsFor(filter);
    if (active >= commands.length) active = 0;
    if (!commands.length) {
      const empty = document.createElement('div');
      empty.className = 'gi-cmdk-empty';
      empty.textContent = 'No matching commands';
      list.append(empty);
      return;
    }
    commands.forEach((command, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.id = `pigeon-command-${index}`;
      row.tabIndex = -1;
      row.className = 'gi-cmdk-row';
      row.dataset.command = command.id;
      row.dataset.active = index === active ? 'true' : 'false';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', index === active ? 'true' : 'false');
      row.textContent = command.label;
      row.onmouseenter = () => {
        active = index;
        paintActive();
      };
      row.onclick = () => choose(index);
      items.push(row);
      list.append(row);
    });
    paintActive();
  };

  input.oninput = () => {
    active = 0;
    render(input.value);
  };
  input.onkeydown = (event) => {
    if (event.key === 'Tab') {
      event.preventDefault(); input.focus();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      active = Math.min(active + 1, Math.max(items.length - 1, 0));
      paintActive(true);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      active = Math.max(active - 1, 0);
      paintActive(true);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      choose(active);
    }
  };
  scrim.addEventListener('click', (event) => {
    if (event.target === scrim) close();
  });
  render('');
  core.append(input, list, foot);
  panel.append(core);
  scrim.append(panel);
  shadow.append(style, scrim);
  document.documentElement.append(host);
  window.addEventListener('keydown', onWindowKey, true);
  input.focus();
}

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Pigeon } from '../ui/Pigeon';

export type PopupIconName = 'gmail' | 'inbox' | 'sparkles' | 'brain' | 'tracking' | 'settings' | 'document' | 'edit' | 'search' | 'arrow' | 'chevron';
export type StatusTone = 'success' | 'warning' | 'error' | 'muted';

export type ConnectionStatus = {
  id: string;
  title: string;
  label: string;
  tone: StatusTone;
  icon: PopupIconName;
};

export type PopupCommand = {
  id: string;
  label: string;
  detail: string;
  icon: PopupIconName;
  disabled?: boolean;
  run: () => void | Promise<void>;
};

export function PopupHeader(props: { status: ConnectionStatus; onSettings: () => void }) {
  return (
    <header className="pb-header">
      <div className="pb-brand">
        <Pigeon size={40} />
        <div className="pb-brand-copy">
          <div className="pb-brand-name">PigeonBox</div>
          <div className="pb-header-status" data-tone={props.status.tone}>
            <StatusDot tone={props.status.tone} />
            <span>{props.status.label}</span>
          </div>
        </div>
      </div>
      <button className="pb-icon-button" type="button" aria-label="Open Settings" title="Settings" onClick={props.onSettings}>
        <PopupIcon name="settings" size={19} />
      </button>
    </header>
  );
}

export function CommandLauncher(props: { onOpen: () => void }) {
  const shortcut = navigator.platform.toLowerCase().includes('mac') ? '⌘ K' : 'Ctrl K';
  return (
    <button
      className="pb-command-launcher"
      type="button"
      aria-label="Open Ask Pigeon command palette"
      onClick={props.onOpen}
    >
      <PopupIcon name="search" size={18} />
      <span>Ask Pigeon or run a command</span>
      <kbd>{shortcut}</kbd>
    </button>
  );
}

export function InboxOverviewCard(props: { indexedThreads: number | null; loading: boolean; onClick: () => void }) {
  const countText = props.indexedThreads == null ? null : new Intl.NumberFormat().format(props.indexedThreads);
  const description = props.loading
    ? 'Checking local mail index'
    : props.indexedThreads === 0
      ? 'Open Gmail to bring mail into view'
      : 'Indexed on this computer';

  return (
    <button className="pb-overview" type="button" aria-label="Open Inbox insights" onClick={props.onClick}>
      <span className="pb-overview-copy">
        <span className="pb-overview-label">Inbox</span>
        {countText == null ? (
          <span className="pb-overview-loading" role="status">{props.loading ? 'Checking…' : 'Insights available'}</span>
        ) : (
          <span className="pb-overview-count">
            <strong>{countText}</strong>
            <span>{countText === '1' ? 'thread indexed' : 'threads indexed'}</span>
          </span>
        )}
        <span className="pb-overview-caption">{description}</span>
      </span>
      <span className="pb-overview-mascot"><Pigeon size={78} /></span>
      <PopupIcon className="pb-overview-chevron" name="chevron" size={17} />
    </button>
  );
}

export function OpenGmailButton(props: { connected: boolean; onClick: () => void }) {
  return (
    <button className="pb-primary" type="button" onClick={props.onClick}>
      <PopupIcon name="gmail" size={26} />
      <span>{props.connected ? 'Open Gmail' : 'Connect Gmail'}</span>
      <PopupIcon name="arrow" size={18} />
    </button>
  );
}

export function QuickActions(props: {
  askButtonRef: RefObject<HTMLButtonElement | null>;
  onInbox: () => void;
  onAsk: () => void;
  onTracking: () => void;
  onSettings: () => void;
}) {
  const actions: Array<{ id: string; label: string; icon: PopupIconName; onClick: () => void; ref?: RefObject<HTMLButtonElement | null> }> = [
    { id: 'inbox', label: 'Inbox insights', icon: 'inbox', onClick: props.onInbox },
    { id: 'ask', label: 'Ask Pigeon', icon: 'sparkles', onClick: props.onAsk, ref: props.askButtonRef },
    { id: 'tracking', label: 'Tracking', icon: 'tracking', onClick: props.onTracking },
    { id: 'settings', label: 'Settings', icon: 'settings', onClick: props.onSettings },
  ];
  return (
    <nav className="pb-quick-actions" aria-label="Quick actions">
      {actions.map((action) => (
        <button key={action.id} ref={action.ref} className="pb-quick-action" type="button" onClick={action.onClick}>
          <PopupIcon name={action.icon} size={23} />
          <span>{action.label}</span>
        </button>
      ))}
    </nav>
  );
}

export function ConnectionFooter(props: { statuses: ConnectionStatus[] }) {
  return (
    <section className="pb-connections" aria-label="Connection status">
      <ul>
        {props.statuses.map((status) => (
          <li key={status.id} className="pb-connection" data-connection={status.id}>
            <PopupIcon name={status.icon} size={19} />
            <span className="pb-connection-copy">
              <span className="pb-connection-title">{status.title}</span>
              <span className="pb-connection-value" data-tone={status.tone}>
                <StatusDot tone={status.tone} />
                {status.label}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CommandPalette(props: {
  commands: PopupCommand[];
  onClose: () => void;
  onAskQuery: (query: string) => void;
  cloud?: boolean;
}) {
  const { commands, onAskQuery } = props;
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = commands.filter((command) =>
      !command.disabled && `${command.label} ${command.detail}`.toLowerCase().includes(needle),
    );
    if (!needle) return matching;

    const fromMatch = needle.match(/^find emails? from\s+(.+)$/i);
    if (fromMatch?.[1]?.trim()) {
      return [{
        id: 'from-query',
        label: `Find emails from ${fromMatch[1].trim()}`,
        detail: props.cloud ? 'Search available synced Cloud mail' : 'Search mail indexed on this computer',
        icon: 'search' as const,
        run: () => onAskQuery(`Find emails from ${fromMatch[1].trim()}`),
      }, ...matching.filter((command) => command.id !== 'ask')];
    }

    const exactDraftWithoutThread = needle === 'draft a reply' && !commands.some((command) => command.id === 'draft-reply');
    if (exactDraftWithoutThread) return [];

    const exactCommand = commands.some((command) => command.label.toLowerCase() === needle && !command.disabled);
    if (!exactCommand) {
      return [{
        id: 'ask-query',
        label: `Ask Pigeon: ${query.trim()}`,
        detail: props.cloud ? 'Ask about available synced Cloud context' : 'Search and ask about indexed mail',
        icon: 'sparkles' as const,
        run: () => onAskQuery(query.trim()),
      }, ...matching.filter((command) => command.id !== 'ask')];
    }
    return matching;
  }, [commands, onAskQuery, query, props.cloud]);

  useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    const trap = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); if (prior?.isConnected) prior.focus(); };
  }, []);

  useEffect(() => {
    if (activeIndex >= items.length) setActiveIndex(0);
  }, [activeIndex, items.length]);

  function choose(index: number): void {
    const item = items[index];
    if (!item || item.disabled) return;
    void item.run();
    props.onClose();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, Math.max(items.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      props.onClose();
    }
  }

  return (
    <div className="pb-command-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <section className="pb-command-dialog" role="dialog" aria-modal="true" aria-label="Ask Pigeon or run a command" data-pb-command-dialog>
        <div className="pb-command-input-row">
          <PopupIcon name="search" size={20} />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label="Ask Pigeon or run a command"
            aria-expanded="true"
            aria-controls="pb-command-results"
            aria-activedescendant={items[activeIndex] ? `pb-command-${items[activeIndex].id}` : undefined}
            placeholder="Ask Pigeon or run a command…"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
            onKeyDown={onKeyDown}
          />
          <kbd>ESC</kbd>
        </div>
        <ul className="pb-command-list" id="pb-command-results" role="listbox" aria-label="Commands">
          {items.length ? items.map((command, index) => (
            <li key={command.id} role="presentation">
              <button
                id={`pb-command-${command.id}`}
                className="pb-command-row"
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                data-active={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(index)}
              >
                <PopupIcon name={command.icon} size={18} />
                <span className="pb-command-copy">
                  <span>{command.label}</span>
                  <small>{command.detail}</small>
                </span>
                {index === activeIndex ? <kbd>↵</kbd> : null}
              </button>
            </li>
          )) : (
            <li className="pb-command-empty" role="status">
              {query.trim().toLowerCase() === 'draft a reply' ? 'Open a Gmail thread to draft a reply.' : 'No matching commands.'}
            </li>
          )}
        </ul>
        <footer className="pb-command-help" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> run</span>
          <span><kbd>esc</kbd> close</span>
        </footer>
      </section>
    </div>
  );
}

export function PopupIcon(props: { name: PopupIconName; size?: number; className?: string }) {
  const size = props.size ?? 20;
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: props.className,
    'aria-hidden': true as const,
    focusable: false as const,
  };

  if (props.name === 'gmail') {
    return (
      <svg {...common} viewBox="0 0 24 24">
        <path d="M3.2 19.5V6.1a2.1 2.1 0 0 1 3.3-1.7L12 8.5l5.5-4.1a2.1 2.1 0 0 1 3.3 1.7v13.4h-3.1V8.2L12 12.4 6.3 8.2v11.3z" fill="#f5f5f2" stroke="none" />
        <path d="M3.2 6.1v13.4h3.1V8.2z" fill="#4285f4" stroke="none" />
        <path d="M17.7 8.2v11.3h3.1V6.1z" fill="#34a853" stroke="none" />
        <path d="M3.2 6.1 12 12.4l8.8-6.3a2.1 2.1 0 0 0-3.3-1.7L12 8.5 6.5 4.4a2.1 2.1 0 0 0-3.3 1.7" fill="#ea4335" stroke="none" />
        <path d="m17.7 8.2 3.1-2.1v3.7l-3.1 2.2z" fill="#fbbc04" stroke="none" />
      </svg>
    );
  }

  const drawings = {
    inbox: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 13h4l2 3h6l2-3h4" /></>,
    sparkles: <><path d="m12 3 1.2 4.1L17 9l-3.8 1.5L12 15l-1.2-4.5L7 9l3.8-1.9L12 3Z" /><path d="m19 14 .7 2.1L22 17l-2.3.9L19 20l-.7-2.1L16 17l2.3-.9L19 14Z" /><path d="m5 14 .6 1.8L7.5 17l-1.9.7L5 20l-.6-2.3L2.5 17l1.9-.8L5 14Z" /></>,
    brain: <><path d="M12 5.5a3.2 3.2 0 0 0-5.8 1.9A3.3 3.3 0 0 0 4.5 13a3.1 3.1 0 0 0 3.2 5.1A3.2 3.2 0 0 0 12 20V5.5Z" /><path d="M12 5.5a3.2 3.2 0 0 1 5.8 1.9 3.3 3.3 0 0 1 1.7 5.6 3.1 3.1 0 0 1-3.2 5.1A3.2 3.2 0 0 1 12 20V5.5Z" /><path d="M8.2 9.5c1.5 0 2.2.8 2.2 2M15.8 9.5c-1.5 0-2.2.8-2.2 2M7.8 15c1.5 0 2.4-.7 2.6-2M16.2 15c-1.5 0-2.4-.7-2.6-2" /></>,
    tracking: <><path d="M4 19V12" /><path d="M10 19V6" /><path d="M16 19V9" /><path d="M22 19V3" /></>,
    settings: <><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" /><path d="m19.4 13.5 1.1.9-1.7 3-1.4-.5a7.7 7.7 0 0 1-1.6.9l-.3 1.5h-3.4l-.3-1.5a7.7 7.7 0 0 1-1.6-.9l-1.4.5-1.7-3 1.1-.9a7.5 7.5 0 0 1 0-1.9l-1.1-.9 1.7-3 1.4.5a7.7 7.7 0 0 1 1.6-.9l.3-1.5h3.4l.3 1.5a7.7 7.7 0 0 1 1.6.9l1.4-.5 1.7 3-1.1.9a7.5 7.5 0 0 1 0 1.9Z" /></>,
    document: <><path d="M7 3.5h7l4.5 4.6v12.4H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z" /><path d="M14 3.8v4.7h4.4M8 13h7M8 16.5h7" /></>,
    edit: <><path d="m4 16.5-.8 4.3 4.3-.8L19 8.5a2.6 2.6 0 0 0-3.7-3.7L4 16.5Z" /><path d="m13.8 6.3 3.7 3.7M4 16.5l3.5 3.5M13 21h7" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></>,
    arrow: <><path d="M4 12h15" /><path d="m13 6 6 6-6 6" /></>,
    chevron: <><path d="m9 5 7 7-7 7" /></>,
  };

  return <svg {...common}>{drawings[props.name]}</svg>;
}

function StatusDot(props: { tone: StatusTone }) {
  return <span className="pb-status-dot" data-tone={props.tone} aria-hidden="true" />;
}

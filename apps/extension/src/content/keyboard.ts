/**
 * PigeonBox keyboard layer: single-key triage for Gmail, in the spirit of
 * Superhuman. Pure key handling lives here; what each command does to Gmail is
 * supplied by the caller (see keyboard-actions.ts), so this module has no DOM
 * side effects beyond reading the event.
 *
 * Keys are ignored while typing (inputs, textareas, editable bodies) except
 * Escape and the compose chords that start with ⌘/Ctrl.
 */

export type ShortcutId =
  | 'next' | 'previous' | 'open' | 'back'
  | 'archive' | 'trash' | 'star' | 'mark_unread' | 'mark_read' | 'select'
  | 'reply' | 'reply_all' | 'forward' | 'compose' | 'search'
  | 'snooze' | 'label' | 'move' | 'undo'
  | 'remind' | 'summarize' | 'draft' | 'mark_respond' | 'mark_waiting' | 'mark_fyi'
  | 'go_inbox' | 'go_starred' | 'go_sent' | 'go_drafts' | 'go_all' | 'go_snoozed' | 'go_scheduled'
  | 'send_later' | 'snippets' | 'help';

export type ShortcutGroup = 'Navigate' | 'Triage' | 'Write' | 'PigeonBox' | 'Go to';

export type Shortcut = { id: ShortcutId; keys: string; label: string; group: ShortcutGroup; compose?: boolean };

/** Display order is the order of the cheat sheet. */
export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'next', keys: 'j', label: 'Next conversation', group: 'Navigate' },
  { id: 'previous', keys: 'k', label: 'Previous conversation', group: 'Navigate' },
  { id: 'open', keys: 'enter', label: 'Open conversation', group: 'Navigate' },
  { id: 'back', keys: 'u', label: 'Back to list', group: 'Navigate' },
  { id: 'search', keys: '/', label: 'Search', group: 'Navigate' },
  { id: 'help', keys: '?', label: 'Show shortcuts', group: 'Navigate' },

  { id: 'archive', keys: 'e', label: 'Archive (done)', group: 'Triage' },
  { id: 'trash', keys: '#', label: 'Move to Trash', group: 'Triage' },
  { id: 'star', keys: 's', label: 'Star / unstar', group: 'Triage' },
  { id: 'mark_unread', keys: 'shift+u', label: 'Mark unread', group: 'Triage' },
  { id: 'mark_read', keys: 'shift+i', label: 'Mark read', group: 'Triage' },
  { id: 'select', keys: 'x', label: 'Select conversation', group: 'Triage' },
  { id: 'snooze', keys: 'h', label: 'Snooze', group: 'Triage' },
  { id: 'label', keys: 'l', label: 'Label', group: 'Triage' },
  { id: 'move', keys: 'v', label: 'Move to', group: 'Triage' },
  { id: 'undo', keys: 'z', label: 'Undo', group: 'Triage' },

  { id: 'compose', keys: 'c', label: 'Compose', group: 'Write' },
  { id: 'reply', keys: 'r', label: 'Reply', group: 'Write' },
  { id: 'reply_all', keys: 'a', label: 'Reply all', group: 'Write' },
  { id: 'forward', keys: 'f', label: 'Forward', group: 'Write' },
  { id: 'send_later', keys: 'mod+shift+l', label: 'Send later', group: 'Write', compose: true },
  { id: 'snippets', keys: 'mod+;', label: 'Insert snippet (or type ;name)', group: 'Write', compose: true },

  { id: 'remind', keys: 'shift+h', label: 'Remind me if no reply', group: 'PigeonBox' },
  { id: 'summarize', keys: 'shift+s', label: 'Summarize thread', group: 'PigeonBox' },
  { id: 'draft', keys: 'shift+d', label: 'Draft a reply with AI', group: 'PigeonBox' },
  { id: 'mark_respond', keys: '1', label: 'Move to Respond', group: 'PigeonBox' },
  { id: 'mark_waiting', keys: '2', label: 'Move to Waiting', group: 'PigeonBox' },
  { id: 'mark_fyi', keys: '3', label: 'Move to FYI', group: 'PigeonBox' },

  { id: 'go_inbox', keys: 'g i', label: 'Inbox', group: 'Go to' },
  { id: 'go_starred', keys: 'g s', label: 'Starred', group: 'Go to' },
  { id: 'go_sent', keys: 'g t', label: 'Sent', group: 'Go to' },
  { id: 'go_drafts', keys: 'g d', label: 'Drafts', group: 'Go to' },
  { id: 'go_snoozed', keys: 'g h', label: 'Snoozed', group: 'Go to' },
  { id: 'go_scheduled', keys: 'g l', label: 'Scheduled', group: 'Go to' },
  { id: 'go_all', keys: 'g a', label: 'All mail', group: 'Go to' },
];

/** Gmail routes for the go-to sequences. */
export const GO_TO_HASH: Partial<Record<ShortcutId, string>> = {
  go_inbox: '#inbox',
  go_starred: '#starred',
  go_sent: '#sent',
  go_drafts: '#drafts',
  go_snoozed: '#snoozed',
  go_scheduled: '#scheduled',
  go_all: '#all',
};

/** How long the second key of a "g …" sequence may wait. */
export const SEQUENCE_MS = 1200;

type KeyLike = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'>;

/**
 * The chord a key event spells, e.g. "e", "shift+u", "mod+shift+l".
 * Symbols that need Shift ("#", "?") are named by the symbol, without "shift+".
 */
export function chordOf(event: KeyLike): string | null {
  if (event.altKey) return null;
  const raw = event.key;
  if (!raw || raw === 'Shift' || raw === 'Meta' || raw === 'Control' || raw === 'Alt') return null;
  const key = raw === 'Enter' ? 'enter' : raw === 'Escape' ? 'escape' : raw.length === 1 ? raw.toLowerCase() : raw.toLowerCase();
  const symbol = raw.length === 1 && !/[a-z0-9]/i.test(raw);
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('mod');
  if (event.shiftKey && !symbol) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

export type KeyboardContext = {
  /** The event target is an input, textarea or editable region. */
  typing: boolean;
  /** The event target is inside a Gmail compose. */
  inCompose: boolean;
};

export type KeyboardLayer = {
  /** The shortcut this key completes, or null. Updates the pending "g" state. */
  resolve(event: KeyLike, context: KeyboardContext, now?: number): ShortcutId | null;
  /** True while a "g" is waiting for its second key. */
  pending(now?: number): boolean;
};

export function createKeyboardLayer(): KeyboardLayer {
  let leader: { key: string; at: number } | null = null;
  const singles = new Map<string, Shortcut>();
  const sequences = new Map<string, Shortcut>();
  for (const shortcut of SHORTCUTS) {
    if (shortcut.keys.includes(' ')) sequences.set(shortcut.keys, shortcut);
    else singles.set(shortcut.keys, shortcut);
  }
  const leaders = new Set([...sequences.keys()].map((keys) => keys.split(' ')[0]));

  return {
    pending(now = Date.now()) {
      return Boolean(leader && now - leader.at <= SEQUENCE_MS);
    },
    resolve(event, context, now = Date.now()) {
      const chord = chordOf(event);
      if (!chord) return null;
      const single = singles.get(chord);
      // While typing, only ⌘/Ctrl chords meant for compose get through.
      if (context.typing) {
        leader = null;
        return single?.compose && context.inCompose ? single.id : null;
      }
      if (leader && now - leader.at <= SEQUENCE_MS) {
        const sequence = sequences.get(`${leader.key} ${chord}`);
        leader = null;
        if (sequence) return sequence.id;
      }
      leader = null;
      if (leaders.has(chord)) {
        leader = { key: chord, at: now };
        return null;
      }
      if (!single || single.compose) return null;
      return single.id;
    },
  };
}

/** Shortcuts grouped for the cheat sheet. */
export function shortcutGroups(): Array<{ group: ShortcutGroup; items: Shortcut[] }> {
  const order: ShortcutGroup[] = ['Navigate', 'Triage', 'Write', 'PigeonBox', 'Go to'];
  return order.map((group) => ({ group, items: SHORTCUTS.filter((item) => item.group === group) }));
}

/** "mod+shift+l" → "⌘ ⇧ L" on Mac, "Ctrl ⇧ L" elsewhere. */
export function displayKeys(keys: string, mac: boolean): string {
  return keys.split(' ').map((chord) => chord.split('+').map((part) => {
    if (part === 'mod') return mac ? '⌘' : 'Ctrl';
    if (part === 'shift') return '⇧';
    if (part === 'enter') return '↵';
    return part.length === 1 ? part.toUpperCase() : part;
  }).join(' ')).join(' then ');
}

import type { AskPigeonResponse } from '@pigeonbox/api-contract';

/**
 * Ask Pigeon chat history, kept in this browser only (chrome.storage.local),
 * never on the PigeonBox server. The user picks how long chats are kept, up to
 * seven days; "Off" keeps nothing and erases what was kept. Signing out of
 * PigeonBox erases it too.
 */

export const ASK_HISTORY_KEY = 'askHistory';
const ACTIVE_CHAT_KEY = 'askActiveChat';
const RETENTION_KEY = 'askHistoryRetentionDays';
export const RETENTION_CHOICES = [0, 1, 3, 7] as const;
export type RetentionDays = (typeof RETENTION_CHOICES)[number];
export const MAX_RETENTION_DAYS = 7;
export const DEFAULT_RETENTION_DAYS: RetentionDays = 7;
/** Per inbox. Older turns go first. */
const MAX_TURNS = 300;
const DAY_MS = 86_400_000;

export type StoredTurn = {
  id: number;
  /** Turns of one conversation share it; only the current conversation is sent to the model. */
  chatId: number;
  at: number;
  question: string;
  /** The Gmail thread open when this was asked, if Ask was scoped to one. */
  threadId?: string;
  answer?: AskPigeonResponse;
  error?: string;
  action?: string;
  /** The reasoning path: one status per tool call, and how long the answer took. */
  steps?: string[];
  took?: number;
  rating?: 'up' | 'down';
  feedback?: 'sent';
  /** The user's answer to proposed changes in this turn. */
  decided?: 'allowed' | 'denied';
};

type Stored = Record<string, StoredTurn[]>;

function local(): chrome.storage.LocalStorageArea | null {
  try {
    return globalThis.chrome?.storage?.local ?? null;
  } catch {
    return null;
  }
}

export function normalizeRetention(value: unknown): RetentionDays {
  return (RETENTION_CHOICES as readonly number[]).includes(value as number) ? (value as RetentionDays) : DEFAULT_RETENTION_DAYS;
}

/** Turns still inside the retention window, oldest first, capped. */
export function prune(turns: StoredTurn[], days: number, now = Date.now()): StoredTurn[] {
  if (days <= 0) return [];
  const since = now - Math.min(days, MAX_RETENTION_DAYS) * DAY_MS;
  return turns.filter((turn) => turn.at >= since && turn.question).slice(-MAX_TURNS);
}

export async function loadAskHistory(scope: string): Promise<{ retentionDays: RetentionDays; turns: StoredTurn[]; activeChatId?: number }> {
  const area = local();
  if (!area) return { retentionDays: DEFAULT_RETENTION_DAYS, turns: [] };
  try {
    const stored = await area.get([ASK_HISTORY_KEY, RETENTION_KEY, ACTIVE_CHAT_KEY]);
    const retentionDays = normalizeRetention(stored[RETENTION_KEY]);
    const all = (stored[ASK_HISTORY_KEY] ?? {}) as Stored;
    const active = (stored[ACTIVE_CHAT_KEY] as Record<string, unknown> | undefined)?.[scope];
    return { retentionDays, turns: prune(Array.isArray(all[scope]) ? all[scope]! : [], retentionDays), ...(retentionDays > 0 && typeof active === 'number' && Number.isSafeInteger(active) ? { activeChatId: active } : {}) };
  } catch {
    return { retentionDays: DEFAULT_RETENTION_DAYS, turns: [] };
  }
}

let writes: Promise<unknown> = Promise.resolve();

/** Saves one inbox's turns and drops expired turns of every inbox. Writes are queued so they never interleave. */
export function saveAskHistory(scope: string, turns: StoredTurn[], retentionDays: number, activeChatId?: number): Promise<unknown> {
  const area = local();
  if (!area) return Promise.resolve();
  writes = writes
    .catch(() => undefined)
    .then(async () => {
      if (retentionDays <= 0) return area.remove([ASK_HISTORY_KEY, ACTIVE_CHAT_KEY]);
      const stored = await area.get([ASK_HISTORY_KEY, ACTIVE_CHAT_KEY]);
      const all = (stored[ASK_HISTORY_KEY] ?? {}) as Stored;
      const next: Stored = {};
      for (const [key, value] of Object.entries(all)) {
        const kept = Array.isArray(value) ? prune(value, retentionDays) : [];
        if (kept.length) next[key] = kept;
      }
      const mine = prune(turns, retentionDays);
      if (mine.length) next[scope] = mine;
      else delete next[scope];
      const active = (stored[ACTIVE_CHAT_KEY] ?? {}) as Record<string, number>;
      if (activeChatId !== undefined) active[scope] = activeChatId;
      return area.set({ [ASK_HISTORY_KEY]: next, [ACTIVE_CHAT_KEY]: active });
    });
  return writes;
}

export function setAskHistoryRetention(days: RetentionDays): Promise<unknown> {
  const area = local();
  if (!area) return Promise.resolve();
  return area.set({ [RETENTION_KEY]: days }).catch(() => undefined);
}

/** Erase every inbox's chats (Clear history, and signing out). */
export function clearAskHistory(): Promise<unknown> {
  const area = local();
  if (!area) return Promise.resolve();
  writes = writes.catch(() => undefined).then(() => area.remove([ASK_HISTORY_KEY, ACTIVE_CHAT_KEY]));
  return writes;
}

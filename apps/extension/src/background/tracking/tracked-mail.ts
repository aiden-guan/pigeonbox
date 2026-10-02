/** The list of tracked sent emails kept in `chrome.storage.local` and pushed to Gmail tabs. */
import type { TrackedEmailSummary } from '@pigeonbox/tracking';
import { broadcastToGmailTabs } from '../messaging';

const KEY = 'trackedEmails';
const MAX_TRACKED = 400;

function isEvictionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return msg.includes('No SW') || msg.includes('No RPH') || msg.includes('Extension context invalidated');
}

export async function readTrackedEmails(): Promise<TrackedEmailSummary[]> {
  try {
    const stored = await chrome.storage.local.get(KEY);
    const value = stored[KEY];
    if (!Array.isArray(value)) return [];
    return value.filter(isSummary);
  } catch (error) {
    if (isEvictionError(error)) return [];
    throw error;
  }
}

async function commitTrackedEmails(emails: TrackedEmailSummary[]): Promise<void> {
  const capped = [...emails]
    .sort((a, b) => ((a.sentAt || a.createdAt || '') < (b.sentAt || b.createdAt || '') ? 1 : (a.sentAt || a.createdAt || '') > (b.sentAt || b.createdAt || '') ? -1 : 0))
    .slice(0, MAX_TRACKED);
  try {
    await chrome.storage.local.set({ [KEY]: capped });
  } catch (error) {
    if (isEvictionError(error)) return;
    throw error;
  }
  // Content scripts cannot read chrome.storage.local (trusted contexts only), so push the list.
  await broadcastToGmailTabs({ type: 'TRACKED_EMAILS_CHANGED', emails: capped });
}

let writes: Promise<unknown> = Promise.resolve();
/** Every read/modify/write, including poll publication and claim reconciliation, shares this queue. */
export function updateTrackedEmails(update: (current: TrackedEmailSummary[]) => TrackedEmailSummary[] | Promise<TrackedEmailSummary[]>): Promise<TrackedEmailSummary[]> {
  const operation = writes.then(async () => {
    const next = await update(await readTrackedEmails());
    await commitTrackedEmails(next);
    return next;
  });
  writes = operation.catch(() => undefined);
  return operation;
}
export async function writeTrackedEmails(emails: TrackedEmailSummary[]): Promise<void> {
  await updateTrackedEmails(() => emails);
}
export function upsertTrackedEmail(email: TrackedEmailSummary): Promise<TrackedEmailSummary[]> {
  return updateTrackedEmails((current) => [...current.filter((item) => item.trackingId !== email.trackingId), email]);
}
export async function patchTrackedEmail(trackingId: string, patch: Partial<TrackedEmailSummary>): Promise<TrackedEmailSummary | null> {
  const rows = await updateTrackedEmails((current) => current.map((item) => item.trackingId === trackingId ? { ...item, ...patch, trackingId } : item));
  return rows.find((item) => item.trackingId === trackingId) || null;
}

function isSummary(value: unknown): value is TrackedEmailSummary {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<TrackedEmailSummary>;
  return typeof row.trackingId === 'string' && (row.sentAt == null || typeof row.sentAt === 'string') && Array.isArray(row.recipients);
}

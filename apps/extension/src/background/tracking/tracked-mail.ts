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

export async function writeTrackedEmails(emails: TrackedEmailSummary[]): Promise<void> {
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

export async function upsertTrackedEmail(email: TrackedEmailSummary): Promise<TrackedEmailSummary[]> {
  const current = await readTrackedEmails();
  const next = current.filter((item) => item.trackingId !== email.trackingId);
  next.push(email);
  await writeTrackedEmails(next);
  return readTrackedEmails();
}

export async function patchTrackedEmail(
  trackingId: string,
  patch: Partial<TrackedEmailSummary>,
): Promise<TrackedEmailSummary | null> {
  const current = await readTrackedEmails();
  const index = current.findIndex((item) => item.trackingId === trackingId);
  if (index < 0) return null;
  current[index] = { ...current[index], ...patch, trackingId };
  await writeTrackedEmails(current);
  return current[index];
}

function isSummary(value: unknown): value is TrackedEmailSummary {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<TrackedEmailSummary>;
  return typeof row.trackingId === 'string' && (row.sentAt == null || typeof row.sentAt === 'string') && Array.isArray(row.recipients);
}

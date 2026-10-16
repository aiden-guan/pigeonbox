import type { TrackedEmailPatch } from '@pigeonbox/tracking';
import { TrackingReceipts } from './receipts';

export const trackerReceipts = new TrackingReceipts<TrackedEmailPatch>('trackingReceipts');

/** Retries and delayed discard messages cannot erase a confirmed Gmail send. */
export function mergeTrackerReceipt(previous: TrackedEmailPatch, next: TrackedEmailPatch): TrackedEmailPatch {
  const sent = previous.status === 'SENT';
  const merged = { ...previous, ...next };
  if (sent && next.status !== 'SENT') {
    for (const field of ['status', 'sent_at', 'subject', 'sender', 'recipients'] as const) {
      if (previous[field] !== undefined) Object.assign(merged, { [field]: previous[field] });
    }
  }
  for (const field of ['gmail_thread_id', 'gmail_message_id', 'sent_at'] as const) {
    if (previous[field] && !next[field]) merged[field] = previous[field];
  }
  if (previous.links || next.links) merged.links = [...new Map([...(previous.links ?? []), ...(next.links ?? [])].map(link => [link.click_id, link])).values()].slice(0, 50);
  return merged;
}

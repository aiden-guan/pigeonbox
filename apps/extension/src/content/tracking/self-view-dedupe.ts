import { normalizeGmailId } from '@pigeonbox/tracking';
import type { SelfViewSource } from './message-self-view';

export type SelfViewReport = {
  trackingId: string;
  gmailThreadId: string | null;
  gmailMessageId: string | null;
  observedAt: number;
  source: SelfViewSource;
};

export type ContentSelfViewRecord = {
  observedAt: number;
  source: SelfViewSource;
};

export class SelfViewDeduplicator {
  private recent = new Map<string, ContentSelfViewRecord>();

  constructor(private readonly windowMs = 10_000) {}

  shouldReport(
    trackingId: string,
    gmailMessageId: string | null | undefined,
    observedAt: number,
    source: SelfViewSource,
  ): boolean {
    const normMessageId = normalizeGmailId(gmailMessageId);
    const key = source === 'PAGE_RELOAD'
      ? `${trackingId}:PAGE_RELOAD`
      : `${trackingId}:${normMessageId || 'unknown'}`;
    const last = this.recent.get(key);

    if (last) {
      // 0. One PAGE_RELOAD per tracked message per document, even after other sources.
      if (source === 'PAGE_RELOAD') {
        if (last.source === 'PAGE_RELOAD') return false;
        this.recent.set(key, { observedAt, source });
        return true;
      }

      // 1. Weak ROW_INTERACTION cannot override stronger signals
      if (source === 'ROW_INTERACTION' && last.source !== 'ROW_INTERACTION') {
        return false;
      }

      // 2. Strong signals supersede weak ROW_INTERACTION
      if (last.source === 'ROW_INTERACTION' && source !== 'ROW_INTERACTION') {
        this.recent.set(key, { observedAt, source });
        return true;
      }

      // 3. Strongest rendering signal: MESSAGE_LOAD must NOT be deduped against MESSAGE_EXPANDED or CACHE_REINSPECTION
      if (source === 'MESSAGE_LOAD' && last.source !== 'MESSAGE_LOAD') {
        this.recent.set(key, { observedAt, source });
        return true;
      }

      // 4. Repeated inspection with identical observation time
      if (observedAt === last.observedAt) {
        return false;
      }

      // 5. CACHE_REINSPECTION with older or identical observation time
      if (source === 'CACHE_REINSPECTION' && observedAt <= last.observedAt) {
        return false;
      }

      // 6. Deliberate re-expansion after >1000ms is allowed (e.g. user collapsed and re-expanded)
      if (source === 'MESSAGE_EXPANDED') {
        if (Math.abs(observedAt - last.observedAt) <= 1000) {
          return false;
        }
        this.recent.set(key, { observedAt, source });
        return true;
      }

      // 7. Deduplicate same-source within window (e.g. repeated ROW_INTERACTION or MESSAGE_LOAD)
      if (source === last.source && Math.abs(observedAt - last.observedAt) <= this.windowMs) {
        return false;
      }

      // 8. General fallback within window for remaining weaker transitions
      if (Math.abs(observedAt - last.observedAt) <= this.windowMs) {
        return false;
      }
    }

    this.recent.set(key, { observedAt, source });
    return true;
  }

  clearRecord(trackingId: string, gmailMessageId?: string | null): void {
    const normMessageId = normalizeGmailId(gmailMessageId);
    this.recent.delete(`${trackingId}:${normMessageId || 'unknown'}`);
    this.recent.delete(`${trackingId}:unknown`);
  }

  clear(): void {
    this.recent.clear();
  }
}

import { detectOpenRequestSource } from './lifecycle';

/** A reservation belongs to one tracker, sent message and document/claim, never the mailbox. */
export type PendingSelfView = {
  issuer: string;
  trackingId: string;
  eventId: string;
  observedAt: number;
  tabId?: number;
  navigation?: boolean;
  retry?: { source: 'ROW_INTERACTION' | 'MESSAGE_EXPANDED' | 'MESSAGE_LOAD' | 'CACHE_REINSPECTION' | 'PAGE_RELOAD'; gmailThreadId?: string | null; gmailMessageId?: string | null; quotedRender?: boolean; reconcileGmailIds?: boolean };
};
type Event = { id: string; tracking_id: string; type: string; timestamp: string; user_agent?: string | null; classification?: string | null; suspected_self_open?: boolean };
export type AttributionSnapshot = { pending: PendingSelfView[]; revisions: Record<string, number>; selfEvents: string[] };

/** No timer settles attribution. Only a canonical claim response or a completed inspection does. */
export class SelfViewAttribution {
  private pending = new Map<string, PendingSelfView>();
  private revisions: Record<string, number> = {};
  private selfEvents = new Set<string>();
  private key(issuer: string, id: string) { return `${issuer}\n${id}`; }
  private claimKey(claim: PendingSelfView) { return `${this.key(claim.issuer, claim.trackingId)}\n${claim.eventId}`; }
  restore(value?: AttributionSnapshot) {
    if (!value) return;
    this.pending = new Map((value.pending || []).map((claim) => [this.claimKey(claim), claim]));
    this.revisions = value.revisions || {};
    this.selfEvents = new Set(value.selfEvents || []);
  }
  snapshot(): AttributionSnapshot {
    return { pending: [...this.pending.values()], revisions: { ...this.revisions }, selfEvents: [...this.selfEvents].slice(-2000) };
  }
  revision(issuer: string, id: string) { return this.revisions[this.key(issuer, id)] || 0; }
  private changed(issuer: string, id: string) { this.revisions[this.key(issuer, id)] = this.revision(issuer, id) + 1; }
  begin(claim: PendingSelfView) {
    const key = this.claimKey(claim);
    if (this.pending.has(key)) return;
    if (!claim.navigation) {
      for (const [id, row] of this.pending) {
        if (row.navigation && row.issuer === claim.issuer && row.trackingId === claim.trackingId && row.tabId === claim.tabId) this.pending.delete(id);
      }
    }
    this.pending.set(key, claim);
    this.changed(claim.issuer, claim.trackingId);
  }
  retry(claim: PendingSelfView, payload: PendingSelfView['retry']) {
    const pending = this.pending.get(this.claimKey(claim));
    if (pending) pending.retry = payload;
  }
  isPending(issuer: string, id: string) {
    return [...this.pending.values()].some((row) => row.issuer === issuer && row.trackingId === id);
  }
  inspected(tabId: number) {
    let released = false;
    for (const [key, row] of this.pending) {
      if (row.navigation && row.tabId === tabId) { this.pending.delete(key); this.changed(row.issuer, row.trackingId); released = true; }
    }
    return released;
  }
  /** Invalidate in-flight polls before committing canonical counters. */
  reconciled(claim: PendingSelfView, reclassifiedEventIds: string[]) {
    for (const id of reclassifiedEventIds) this.selfEvents.add(`${claim.issuer}\n${id}`);
    this.changed(claim.issuer, claim.trackingId);
  }
  settled(claim: PendingSelfView) {
    this.pending.delete(this.claimKey(claim));
    this.changed(claim.issuer, claim.trackingId);
  }
  publishable(issuer: string, id: string, revision: number) {
    return !this.isPending(issuer, id) && this.revision(issuer, id) === revision;
  }
  events<T extends Event>(issuer: string, events: T[]): T[] {
    return events.filter((event) => {
      if (this.selfEvents.has(`${issuer}\n${event.id}`)) return false;
      if (event.classification === 'SELF_LIKELY' || event.suspected_self_open) return true;
      if (event.type !== 'OPEN' && event.type !== 'CLICK') return true;
      const source = detectOpenRequestSource(event.user_agent);
      if (source === 'scanner' || source === 'headless') return true;
      const ts = Date.parse(event.timestamp);
      return ![...this.pending.values()].some((row) => row.issuer === issuer && row.trackingId === event.tracking_id && ts >= row.observedAt - 5000);
    });
  }
}

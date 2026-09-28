import { describe, expect, it } from 'vitest';
import { SelfViewDeduplicator } from './self-view-dedupe';

describe('SelfViewDeduplicator', () => {
  it('allows MESSAGE_EXPANDED to supersede an earlier ROW_INTERACTION', () => {
    const dedupe = new SelfViewDeduplicator(10_000);

    // T = 0: sender pointerdown on row
    expect(dedupe.shouldReport('trk_123', 'msg_1', 0, 'ROW_INTERACTION')).toBe(true);

    // T = 200: duplicate ROW_INTERACTION is suppressed
    expect(dedupe.shouldReport('trk_123', 'msg_1', 200, 'ROW_INTERACTION')).toBe(false);

    // T = 4000: message actually EXPANDS (stronger signal)
    // MUST supersede the earlier ROW_INTERACTION!
    expect(dedupe.shouldReport('trk_123', 'msg_1', 4000, 'MESSAGE_EXPANDED')).toBe(true);

    // T = 4000: repeated MESSAGE_EXPANDED for same observation time is suppressed
    expect(dedupe.shouldReport('trk_123', 'msg_1', 4000, 'MESSAGE_EXPANDED')).toBe(false);

    // T = 5000: a subsequent ROW_INTERACTION cannot override the strong MESSAGE_EXPANDED signal
    expect(dedupe.shouldReport('trk_123', 'msg_1', 5000, 'ROW_INTERACTION')).toBe(false);

    // T = 6000: CACHE_REINSPECTION with same observation timestamp (4000) is suppressed
    expect(dedupe.shouldReport('trk_123', 'msg_1', 4000, 'CACHE_REINSPECTION')).toBe(false);
  });

  it('deduplicates aggressive repeated ROW_INTERACTIONS within 10s', () => {
    const dedupe = new SelfViewDeduplicator(10_000);

    expect(dedupe.shouldReport('trk_123', 'msg_1', 1000, 'ROW_INTERACTION')).toBe(true);
    expect(dedupe.shouldReport('trk_123', 'msg_1', 2000, 'ROW_INTERACTION')).toBe(false);
    expect(dedupe.shouldReport('trk_123', 'msg_1', 9000, 'ROW_INTERACTION')).toBe(false);

    // Outside 10s window:
    expect(dedupe.shouldReport('trk_123', 'msg_1', 12000, 'ROW_INTERACTION')).toBe(true);
  });

  it('allows MESSAGE_LOAD to report even after MESSAGE_EXPANDED within window', () => {
    const dedupe = new SelfViewDeduplicator(10_000);

    // T = 0: sender expands message
    expect(dedupe.shouldReport('trk_123', 'msg_1', 0, 'MESSAGE_EXPANDED')).toBe(true);

    // T = 9000: Gmail loads message body and fires MESSAGE_LOAD at T+9s
    // MUST NOT be suppressed by the T0 MESSAGE_EXPANDED!
    expect(dedupe.shouldReport('trk_123', 'msg_1', 9000, 'MESSAGE_LOAD')).toBe(true);

    // Repeated MESSAGE_LOAD at same observation time is suppressed
    expect(dedupe.shouldReport('trk_123', 'msg_1', 9000, 'MESSAGE_LOAD')).toBe(false);

    // Repeated MESSAGE_LOAD within window is suppressed
    expect(dedupe.shouldReport('trk_123', 'msg_1', 12000, 'MESSAGE_LOAD')).toBe(false);

    // Outside window MESSAGE_LOAD is allowed
    expect(dedupe.shouldReport('trk_123', 'msg_1', 20000, 'MESSAGE_LOAD')).toBe(true);
  });

  it('isolates different tracking IDs and message IDs', () => {
    const dedupe = new SelfViewDeduplicator(10_000);

    expect(dedupe.shouldReport('trk_1', 'msg_1', 1000, 'MESSAGE_EXPANDED')).toBe(true);
    // Different message in same or different tracking ID
    expect(dedupe.shouldReport('trk_1', 'msg_2', 1000, 'MESSAGE_EXPANDED')).toBe(true);
    // Different tracking ID
    expect(dedupe.shouldReport('trk_2', 'msg_1', 1000, 'MESSAGE_EXPANDED')).toBe(true);
  });

  it('allows MESSAGE_LOAD to report after CACHE_REINSPECTION', () => {
    const dedupe = new SelfViewDeduplicator(10_000);

    // T = 0: message expanded, but cache was missing so CACHE_REINSPECTION reports at T=0
    expect(dedupe.shouldReport('trk_123', 'msg_1', 0, 'CACHE_REINSPECTION')).toBe(true);

    // T = 9000: message load completes
    // MUST NOT be suppressed by the prior CACHE_REINSPECTION
    expect(dedupe.shouldReport('trk_123', 'msg_1', 9000, 'MESSAGE_LOAD')).toBe(true);
  });

  it('allows CACHE_REINSPECTION to upgrade an earlier weak ROW_INTERACTION', () => {
    const dedupe = new SelfViewDeduplicator(10_000);

    // T = 0: row interaction
    expect(dedupe.shouldReport('trk_123', 'msg_1', 0, 'ROW_INTERACTION')).toBe(true);

    // T = 500: cache reinspection resolves the actual message expansion
    expect(dedupe.shouldReport('trk_123', 'msg_1', 500, 'CACHE_REINSPECTION')).toBe(true);
  });

  it('allows deliberate re-expansion of message after >1s', () => {
    const dedupe = new SelfViewDeduplicator(10_000);

    // T = 0: sender expands message
    expect(dedupe.shouldReport('trk_123', 'msg_1', 0, 'MESSAGE_EXPANDED')).toBe(true);

    // T = 200: immediate duplicate event for same UI action is suppressed
    expect(dedupe.shouldReport('trk_123', 'msg_1', 200, 'MESSAGE_EXPANDED')).toBe(false);

    // T = 3000: sender collapsed and re-expanded after 3s -> deliberate re-expansion is allowed
    expect(dedupe.shouldReport('trk_123', 'msg_1', 3000, 'MESSAGE_EXPANDED')).toBe(true);
  });

  it('clearRecord on collapse allows immediate re-expansion', () => {
    const dedupe = new SelfViewDeduplicator(10_000);

    // T = 0: sender expands message
    expect(dedupe.shouldReport('trk_123', 'msg_1', 0, 'MESSAGE_EXPANDED')).toBe(true);

    // Collapse event clears the deduplicator record
    dedupe.clearRecord('trk_123', 'msg_1');

    // T = 500: re-expansion immediately after collapse is allowed
    expect(dedupe.shouldReport('trk_123', 'msg_1', 500, 'MESSAGE_EXPANDED')).toBe(true);
  });

  it('reports one PAGE_RELOAD per tracked message even after another source', () => {
    const dedupe = new SelfViewDeduplicator(10_000);
    expect(dedupe.shouldReport('trk_123', 'msg_1', 5_000, 'MESSAGE_EXPANDED')).toBe(true);
    expect(dedupe.shouldReport('trk_123', 'msg_1', 1_000, 'PAGE_RELOAD')).toBe(true);
    expect(dedupe.shouldReport('trk_123', 'msg_1', 1_000, 'PAGE_RELOAD')).toBe(false);
    expect(dedupe.shouldReport('trk_123', 'other_msg', 4_000, 'PAGE_RELOAD')).toBe(false);
    expect(dedupe.shouldReport('trk_123', 'msg_1', 20_000, 'PAGE_RELOAD')).toBe(false);
    expect(dedupe.shouldReport('trk_other', 'msg_1', 1_000, 'PAGE_RELOAD')).toBe(true);
  });
});

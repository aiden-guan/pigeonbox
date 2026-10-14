import { describe, expect, it } from 'vitest';
import {
  emptyImportanceModel,
  importanceFeatures,
  importanceModel,
  importanceReasons,
  importanceScore,
  learnImportance,
  rankByImportance,
  senderDomain,
  type ImportanceInput,
} from './importance';

const now = Date.parse('2026-10-12T12:00:00Z');
const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
function thread(patch: Partial<ImportanceInput> = {}): ImportanceInput {
  return {
    classification: 'FYI',
    priority: 'NORMAL',
    requiresResponse: false,
    latestTimestamp: hoursAgo(2),
    messageCount: 1,
    latestSender: { email: 'someone@company.test' },
    ...patch,
  };
}
const score = (input: ImportanceInput, model = emptyImportanceModel(), repliedTo = new Set<string>()) =>
  importanceScore(model, importanceFeatures(input, { model, repliedTo, now }));

describe('importance ranking', () => {
  it('ranks mail that needs a reply above FYI, and bulk mail last, before learning anything', () => {
    const respond = score(thread({ classification: 'RESPOND', requiresResponse: true }));
    const fyi = score(thread());
    const promo = score(thread({ classification: 'PROMOTIONS', priority: 'LOW' }));
    expect(respond).toBeGreaterThan(fyi);
    expect(fyi).toBeGreaterThan(promo);
  });

  it('prefers people you write to, deadlines and newer mail', () => {
    expect(score(thread(), undefined, new Set(['someone@company.test']))).toBeGreaterThan(score(thread()));
    expect(score(thread({ deadline: '2026-10-14' }))).toBeGreaterThan(score(thread()));
    expect(score(thread({ latestTimestamp: hoursAgo(1) }))).toBeGreaterThan(score(thread({ latestTimestamp: hoursAgo(24 * 7) })));
  });

  it('learns a sender matters after a couple of moves to Respond', () => {
    let model = emptyImportanceModel();
    const fromAlice = thread({ latestSender: { email: 'alice@startup.test' } });
    const fromBob = thread({ latestSender: { email: 'bob@other.test' } });
    expect(score(fromAlice, model)).toBeCloseTo(score(fromBob, model));
    for (let i = 0; i < 2; i += 1)
      model = learnImportance(model, importanceFeatures(fromAlice, { model, repliedTo: new Set(), now }), 'moved_respond', 'alice@startup.test');
    expect(score(fromAlice, model)).toBeGreaterThan(score(fromBob, model) + 0.1);
    // Others at the same organization rise a little too.
    expect(score(thread({ latestSender: { email: 'carol@startup.test' } }), model)).toBeGreaterThan(score(fromBob, model));
  });

  it('learns to push down a sender whose mail keeps getting archived', () => {
    let model = emptyImportanceModel();
    const news = thread({ classification: 'RESPOND', latestSender: { email: 'digest@newsletter.test' } });
    const before = score(news, model);
    for (let i = 0; i < 3; i += 1) model = learnImportance(model, importanceFeatures(news, { model, repliedTo: new Set(), now }), 'archived', 'digest@newsletter.test');
    expect(score(news, model)).toBeLessThan(before - 0.15);
  });

  it('does not treat a shared mail provider as an organization', () => {
    expect(senderDomain('friend@gmail.com')).toBeNull();
    expect(senderDomain('Prof@Berkeley.edu')).toBe('berkeley.edu');
  });

  it('reads stored models defensively', () => {
    expect(importanceModel(null)).toEqual(emptyImportanceModel());
    const model = importanceModel({ version: 1, weights: { respond: Number.NaN, high: 99 }, senders: { 'a@b.test': { up: 1, down: 'x' } }, domains: {}, updates: 3 });
    expect(model.weights.respond).toBe(emptyImportanceModel().weights.respond);
    expect(model.weights.high).toBe(6);
    expect(model.senders).toEqual({});
  });

  it('explains the top reasons and sorts by importance, newest first on ties', () => {
    const model = emptyImportanceModel();
    const features = importanceFeatures(thread({ classification: 'RESPOND', priority: 'HIGH' }), { model, repliedTo: new Set(), now });
    expect(importanceReasons(model, features)).toEqual(['Needs your reply', 'High priority']);
    const rows = rankByImportance([
      { id: 'old', timestamp: hoursAgo(5), importance: 0.5 },
      { id: 'top', timestamp: hoursAgo(9), importance: 0.9 },
      { id: 'new', timestamp: hoursAgo(1), importance: 0.501 },
    ]);
    expect(rows.map((row) => row.id)).toEqual(['top', 'new', 'old']);
  });
});

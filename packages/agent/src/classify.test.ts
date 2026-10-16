import { describe, expect, it } from 'vitest';
import {
  ClassificationResultSchema,
  detectPlaceholders,
  contentFingerprint,
  hashBody,
  stripHtml,
  sanitizeEmailHtml,
} from '@pigeonbox/shared';
import {
  applyRules,
  archiveDecision,
  classifyHeuristic,
  detectNeedsReply,
  parseNaturalLanguageRule,
  computePriority,
} from '@pigeonbox/agent';

describe('classification schema', () => {
  it('accepts valid structured output', () => {
    const r = ClassificationResultSchema.parse({
      category: 'RESPOND',
      confidence: 0.9,
      priority: 'HIGH',
      needsReply: true,
      waitingOnReply: false,
      archiveRecommendation: false,
      reason: 'Question asked',
      deadline: null,
    });
    expect(r.category).toBe('RESPOND');
  });

  it('rejects malformed outputs', () => {
    expect(() =>
      ClassificationResultSchema.parse({ category: 'NOPE', confidence: 2 }),
    ).toThrow();
  });
});

describe('heuristics', () => {
  it('classifies noreply as NOTIFICATIONS', () => {
    const r = classifyHeuristic({
      subject: 'Password reset',
      snippet: 'reset your password',
      bodyText: 'Click to reset your password',
      latestSenderEmail: 'noreply@example.com',
      direction: 'inbound',
      isNoreply: true,
    });
    expect(r?.category).toBe('NOTIFICATIONS');
    expect(r?.archiveRecommendation).toBe(true);
  });

  it('classifies outbound as WAITING', () => {
    const r = classifyHeuristic({
      subject: 'Quick question',
      snippet: 'Can you review?',
      bodyText: 'Can you review the doc?',
      latestSenderEmail: 'me@example.com',
      direction: 'outbound',
      userIsLatestMeaningfulSender: true,
    });
    expect(r?.category).toBe('WAITING');
  });

  it('detects needs-reply questions', () => {
    const r = detectNeedsReply({
      subject: 'Meeting',
      snippet: '',
      bodyText: 'Can you meet Friday?',
      latestSenderEmail: 'a@b.com',
      direction: 'inbound',
    });
    expect(r.needsReply).toBe(true);
  });

  it('does not need reply for receipts', () => {
    const r = detectNeedsReply({
      subject: 'Your receipt',
      snippet: '',
      bodyText: 'Payment received. Order confirmed.',
      latestSenderEmail: 'orders@shop.com',
      direction: 'inbound',
    });
    expect(r.needsReply).toBe(false);
  });
});

describe('rules override AI/heuristics', () => {
  it('force category from user rule', () => {
    const r = applyRules(
      {
        subject: 'Hello',
        snippet: '',
        bodyText: 'hi',
        latestSenderEmail: 'founder@ycombinator.com',
        direction: 'inbound',
      },
      [{ kind: 'force_category', match: 'domain', value: 'ycombinator.com', category: 'RESPOND' }],
    );
    expect(r?.category).toBe('RESPOND');
    expect(r?.confidence).toBe(1);
  });

  it('parses natural language never-archive', () => {
    expect(parseNaturalLanguageRule('never archive berkeley.edu')).toEqual({
      kind: 'never_archive_domain',
      domain: 'berkeley.edu',
    });
  });
});

describe('archive confidence threshold', () => {
  it('recommends only below threshold', () => {
    const d = archiveDecision({
      category: 'PROMOTIONS',
      confidence: 0.8,
      senderEmail: 'deals@shop.com',
      archiveCategories: ['PROMOTIONS', 'NEWS', 'NOTIFICATIONS'],
      threshold: 0.95,
      alwaysArchive: [],
      neverArchive: [],
      rules: [],
    });
    expect(d.shouldArchive).toBe(true);
    expect(d.autonomous).toBe(false);
  });

  it('never archives RESPOND by default', () => {
    const d = archiveDecision({
      category: 'RESPOND',
      confidence: 1,
      senderEmail: 'a@b.com',
      archiveCategories: ['RESPOND'],
      threshold: 0.5,
      alwaysArchive: [],
      neverArchive: [],
      rules: [],
    });
    expect(d.shouldArchive).toBe(false);
  });

  it('NEVER ARCHIVE > ALWAYS ARCHIVE', () => {
    const d = archiveDecision({
      category: 'PROMOTIONS',
      confidence: 1,
      senderEmail: 'x@shop.com',
      archiveCategories: ['PROMOTIONS'],
      threshold: 0.5,
      alwaysArchive: ['shop.com'],
      neverArchive: ['shop.com'],
      rules: [],
    });
    expect(d.shouldArchive).toBe(false);
  });
});

describe('placeholders and fingerprint', () => {
  it('detects placeholders', () => {
    expect(detectPlaceholders('See you on [DATE] at [TIME]')).toEqual(['[DATE]', '[TIME]']);
  });

  it('stable fingerprint changes with body', async () => {
    const a = await contentFingerprint({
      gmailThreadId: 't1',
      latestMessageId: 'm1',
      latestTimestamp: '2026-01-01',
      normalizedBodyHash: await hashBody('hello'),
    });
    const b = await contentFingerprint({
      gmailThreadId: 't1',
      latestMessageId: 'm1',
      latestTimestamp: '2026-01-01',
      normalizedBodyHash: await hashBody('hello world'),
    });
    expect(a).not.toBe(b);
  });

  it('strips and sanitizes HTML', () => {
    expect(stripHtml('<b>Hi</b><script>x</script>')).toBe('Hi');
    expect(sanitizeEmailHtml('<img onerror=alert(1) src=x>')).not.toMatch(/onerror/i);
  });
});

describe('priority', () => {
  it('elevates response + known contact', () => {
    const p = computePriority({
      requiresResponse: true,
      senderKnown: true,
      previouslyEmailed: true,
      isList: false,
      hasDeadline: false,
      priorityDomain: false,
    });
    expect(p.priority).toBe('HIGH');
  });
});

describe('archive autonomous above threshold', () => {
  it('archives PROMOTIONS when confidence meets threshold', () => {
    const d = archiveDecision({
      category: 'PROMOTIONS',
      confidence: 0.96,
      senderEmail: 'deals@shop.com',
      archiveCategories: ['PROMOTIONS', 'NEWS', 'NOTIFICATIONS'],
      threshold: 0.95,
      alwaysArchive: [],
      neverArchive: [],
      rules: [],
    });
    expect(d.shouldArchive).toBe(true);
    expect(d.autonomous).toBe(true);
  });

  it('requires review for a model-derived category even at maximum confidence', () => {
    const input = { category: 'PROMOTIONS' as const, confidence: 1, senderEmail: 'attacker@bad.test', archiveCategories: ['PROMOTIONS' as const], threshold: 0.8, alwaysArchive: [], neverArchive: [], rules: [], modelDerived: true };
    expect(archiveDecision(input)).toMatchObject({ shouldArchive: true, autonomous: false });
    // An explicit sender rule is the person's authority, independent of the model.
    expect(archiveDecision({ ...input, alwaysArchive: ['attacker@bad.test'] })).toMatchObject({ shouldArchive: true, autonomous: true });
  });
});

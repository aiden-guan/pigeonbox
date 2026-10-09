import { describe, expect, it } from 'vitest';
import { ComposeCheckRequestSchema, ComposeCheckResponseSchema, PreferencesSchema, PreferencesUpdateRequestSchema, ROUTES } from './index';

const request = { recipientEmails: ['alex@example.test'], subject: 'Coffee', claim: "I'm free tomorrow at 3" };
const notice = {
  status: 'notice',
  kind: 'calendar_conflict',
  severity: 'warning',
  message: 'You have Math 52 from 2–4 PM tomorrow.',
  confidence: 0.98,
  sources: [{ id: 'event:math52', kind: 'calendar_event', title: 'Math 52' }],
};

describe('compose check contract', () => {
  it('accepts a bounded clause and the no-op, disabled and notice answers', () => {
    expect(ComposeCheckRequestSchema.parse({ ...request, threadId: '18c2f0a1b2c3d4e5', hint: 'availability', mailbox: 'me@example.test' })).toMatchObject(request);
    expect(ComposeCheckResponseSchema.parse({ status: 'none' })).toEqual({ status: 'none' });
    expect(ComposeCheckResponseSchema.parse({ status: 'disabled' })).toEqual({ status: 'disabled' });
    expect(ComposeCheckResponseSchema.parse({ ...notice, suggestedText: "I'm free tomorrow at 4:30." })).toMatchObject({ status: 'notice' });
  });

  it('carries at most 700 characters of draft text and nothing like a whole draft', () => {
    expect(ComposeCheckRequestSchema.safeParse({ ...request, claim: 'x'.repeat(700) }).success).toBe(true);
    expect(ComposeCheckRequestSchema.safeParse({ ...request, claim: 'x'.repeat(701) }).success).toBe(false);
    expect(ComposeCheckRequestSchema.safeParse({ ...request, claim: '  ' }).success).toBe(false);
    expect(ComposeCheckRequestSchema.safeParse({ ...request, subject: 's'.repeat(999) }).success).toBe(false);
    expect(ComposeCheckRequestSchema.safeParse({ ...request, body: 'whole draft' }).data).not.toHaveProperty('body');
    expect(ComposeCheckRequestSchema.safeParse({ ...request, hint: 'everything' }).success).toBe(false);
  });

  it('rejects invalid or too many recipients', () => {
    for (const recipientEmails of [['not-an-email'], ['a@b.test', 'Alex <alex@x.test>'], Array.from({ length: 21 }, (_, i) => `p${i}@x.test`)])
      expect(ComposeCheckRequestSchema.safeParse({ ...request, recipientEmails }).success).toBe(false);
    expect(ComposeCheckRequestSchema.safeParse({ ...request, recipientEmails: Array.from({ length: 20 }, (_, i) => `p${i}@x.test`) }).success).toBe(true);
  });

  it('bounds notices: message, suggestion, confidence and sources', () => {
    for (const bad of [
      { ...notice, message: 'm'.repeat(241) },
      { ...notice, message: '' },
      { ...notice, suggestedText: 's'.repeat(701) },
      { ...notice, confidence: 1.2 },
      { ...notice, confidence: -0.1 },
      { ...notice, sources: Array.from({ length: 5 }, (_, i) => ({ ...notice.sources[0], id: `event:${i}` })) },
      { ...notice, kind: 'grammar' },
    ])
      expect(ComposeCheckResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('is an authenticated POST route gated on Cloud, not an inference operation', () => {
    expect(ROUTES.composeCheck).toMatchObject({ method: 'POST', path: '/v1/compose/check', auth: 'user', capability: 'cloud_mail_sync' });
    expect('operation' in ROUTES.composeCheck).toBe(false);
  });

  it('defaults Real-time Pidgy checks off, separate from learning, and keeps partial updates partial', () => {
    expect(PreferencesSchema.shape.memory.parse(undefined).realtimeComposeChecks).toBe(false);
    // Preferences saved before the setting existed read as off.
    expect(PreferencesSchema.shape.memory.parse({ enabled: true, learnFromReceivedMail: true, learnFromSentMail: true, learnFromDraftEdits: true }).realtimeComposeChecks).toBe(false);
    const update = PreferencesUpdateRequestSchema.parse({ preferences: { memory: { realtimeComposeChecks: true } } });
    expect(update.preferences.memory).toEqual({ realtimeComposeChecks: true });
    const learning = PreferencesUpdateRequestSchema.parse({ preferences: { memory: { enabled: false } } });
    expect(learning.preferences.memory).toEqual({ enabled: false });
  });
});

it('accepts broad routing hints while bounding semantic notice fields', () => {
  expect(ComposeCheckRequestSchema.safeParse({claim:"i don't think i have any upcoming hackathons",subject:'Plans',recipientEmails:[],hint:'existence'}).success).toBe(true);
  expect(ComposeCheckResponseSchema.safeParse({status:'notice',kind:'overlooked_context',severity:'info',message:'You have CalHacks Oct 23–25.',confidence:0.96,highlightText:'any upcoming hackathons',sources:[]}).success).toBe(true);
  expect(ComposeCheckResponseSchema.safeParse({status:'notice',kind:'context',severity:'info',message:'A fact.',confidence:0.96,highlightText:'x'.repeat(161),sources:[]}).success).toBe(false);
});

it('validates optional continuations and preserves legacy none/notice replies', () => {
  const completion = { text: ' with relevant context.', confidence: 0.96, sources: [{ id:'memory:one',kind:'note',title:'User context' }] };
  expect(ComposeCheckResponseSchema.safeParse({ status:'none',completion }).success).toBe(true);
  for (const patch of [{text:'x'.repeat(241)},{sources:[]},{confidence:1.1}]) expect(ComposeCheckResponseSchema.safeParse({status:'none',completion:{...completion,...patch}}).success).toBe(false);
  expect(ComposeCheckResponseSchema.parse({status:'none'})).toEqual({status:'none'});
  expect(PreferencesSchema.shape.memory.parse({ enabled:true,learnFromReceivedMail:true,learnFromSentMail:true,learnFromDraftEdits:true,realtimeComposeChecks: true }).smartComposeCompletion).toBe(false);
});

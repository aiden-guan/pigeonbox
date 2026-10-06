import { describe, expect, it } from 'vitest';
import { MemoryListRequestSchema, MemoryUpdateRequestSchema, MemoryPurgeRequestSchema, MemorySubjectsResponseSchema, PersonalMemorySchema } from './memory';
import { PreferencesSchema, ROUTES } from './index';

describe('memory wire contracts', () => {
  it('bounds pages, selectors and correction text, and requires exact purge intent', () => {
    expect(MemoryListRequestSchema.parse({})).toMatchObject({ limit: 20, includeHistory: false });
    for (const input of [{ limit: 51 }, { cursor: '-1' }, { query: 'x'.repeat(501) }]) expect(MemoryListRequestSchema.safeParse(input).success).toBe(false);
    expect(MemoryUpdateRequestSchema.safeParse({ memoryId: 'foreign-identifier', text: 'A useful correction.' }).success).toBe(false);
    expect(MemoryPurgeRequestSchema.safeParse({ confirm: 'yes' }).success).toBe(false);
    expect(MemoryPurgeRequestSchema.safeParse({ confirm: 'forget all memories' }).success).toBe(true);
  });
  it('keeps controls authenticated and available without a subscription, with backwards-compatible preference defaults', () => {
    for (const route of [ROUTES.memoryList, ROUTES.memoryGet, ROUTES.memoryForget, ROUTES.memoryUpdate, ROUTES.memoryPurge, ROUTES.memorySubjects]) {
      expect(route.auth).toBe('user');
      expect(route.method).toBe('POST');
      expect('capability' in route).toBe(false);
    }
    expect(PreferencesSchema.shape.memory.parse(undefined)).toEqual({
      enabled: true,
      learnFromReceivedMail: true,
      learnFromSentMail: true,
      learnFromDraftEdits: true,
      realtimeComposeChecks: false,
    });
    expect(PersonalMemorySchema.safeParse({ text_key_id: 'private' }).success).toBe(false);
  });
  it('scopes pages by opaque subject ids and keeps subject optional for older facts', () => {
    expect(MemoryListRequestSchema.safeParse({ subject: 'a'.repeat(64) }).success).toBe(true);
    expect(MemoryListRequestSchema.safeParse({ subject: 'ada@example.com' }).success).toBe(false);
    const base = {
      id: '00000000-0000-4000-8000-000000000000', kind: 'semantic', category: 'other', text: 'Studies data science.', confidence: 0.9, status: 'active',
      validFrom: '2026-10-01T00:00:00.000Z', validUntil: null, lastConfirmedAt: '2026-10-01T00:00:00.000Z', corrected: false, entities: [], sources: [],
    };
    expect(PersonalMemorySchema.safeParse(base).success).toBe(true);
    expect(PersonalMemorySchema.safeParse({ ...base, subject: { id: 'b'.repeat(64), type: 'self', label: 'You' } }).success).toBe(true);
    expect(MemorySubjectsResponseSchema.safeParse({ subjects: [{ id: 'b'.repeat(64), type: 'robot', label: 'x', summary: null, factCount: 1, lastConfirmedAt: base.validFrom }], organizing: false }).success).toBe(false);
  });
});

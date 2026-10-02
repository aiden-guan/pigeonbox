import { describe, expect, it } from 'vitest';
import { MemoryListRequestSchema, MemoryUpdateRequestSchema, MemoryPurgeRequestSchema, PersonalMemorySchema } from './memory';
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
    for (const route of [ROUTES.memoryList, ROUTES.memoryGet, ROUTES.memoryForget, ROUTES.memoryUpdate, ROUTES.memoryPurge]) {
      expect(route.auth).toBe('user');
      expect(route.method).toBe('POST');
      expect('capability' in route).toBe(false);
    }
    expect(PreferencesSchema.shape.memory.parse(undefined)).toEqual({
      enabled: true,
      learnFromReceivedMail: true,
      learnFromSentMail: true,
      learnFromDraftEdits: true,
    });
    expect(PersonalMemorySchema.safeParse({ text_key_id: 'private' }).success).toBe(false);
  });
});

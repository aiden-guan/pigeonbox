import { z } from 'zod';
import { InstantSchema, LimitSchema, SourceRefSchema } from './common.js';

export const MemoryKindSchema = z.enum(['episodic', 'semantic', 'preference', 'instruction', 'decision', 'goal', 'relationship_fact']);
export const MemoryCategorySchema = z.enum(['people', 'projects', 'classes', 'logistics', 'decisions', 'preferences', 'other']);
export const MemoryEntitySchema = z.object({
  type: z.enum(['contact', 'company', 'email', 'course', 'project', 'topic', 'event', 'thread']),
  key: z.string().min(1).max(200),
});
export const PersonalMemorySchema = z.object({
  id: z.string().uuid(),
  kind: MemoryKindSchema,
  category: MemoryCategorySchema,
  text: z.string().min(1).max(600),
  confidence: z.number().min(0).max(1),
  status: z.enum(['active', 'superseded']),
  validFrom: InstantSchema,
  validUntil: InstantSchema.nullable(),
  lastConfirmedAt: InstantSchema,
  corrected: z.boolean(),
  entities: z.array(MemoryEntitySchema).max(12),
  sources: z.array(SourceRefSchema).max(12),
});
export type PersonalMemory = z.infer<typeof PersonalMemorySchema>;
export const MemoryListRequestSchema = z.object({
  query: z.string().max(500).optional(),
  category: MemoryCategorySchema.optional(),
  includeHistory: z.boolean().default(false),
  limit: LimitSchema(50, 20),
  cursor: z
    .string()
    .regex(/^\d{1,8}$/)
    .optional(),
});
export const MemoryListResponseSchema = z.object({ memories: z.array(PersonalMemorySchema).max(50), nextCursor: z.string().nullable() });
export const MemoryIdRequestSchema = z.object({ memoryId: z.string().uuid() });
export const MemoryResponseSchema = z.object({ memory: PersonalMemorySchema });
export const MemoryUpdateRequestSchema = MemoryIdRequestSchema.extend({
  text: z.string().trim().min(10).max(600),
  validUntil: InstantSchema.nullable().optional(),
});
export const MemoryPurgeRequestSchema = z.object({ confirm: z.literal('forget all memories') });
export const MemoryPurgeResponseSchema = z.object({ removed: z.number().int().nonnegative() });

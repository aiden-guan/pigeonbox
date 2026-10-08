import { z } from 'zod';
import { InstantSchema, LimitSchema, SourceRefSchema } from './common.js';

export const MemoryKindSchema = z.enum(['episodic', 'semantic', 'preference', 'instruction', 'decision', 'goal', 'relationship_fact']);
export const MemoryCategorySchema = z.enum(['people', 'projects', 'classes', 'logistics', 'decisions', 'preferences', 'other']);
export const MemoryEntitySchema = z.object({
  type: z.enum(['contact', 'company', 'email', 'course', 'project', 'topic', 'event', 'thread']),
  key: z.string().min(1).max(200),
});
/**
 * A memory page: who or what a group of facts is about. `self` is the account
 * owner across every connected inbox; a person is one correspondent; a topic is
 * a project, course or organization. The id is an opaque keyed digest.
 */
export const MemorySubjectTypeSchema = z.enum(['self', 'person', 'topic']);
export const MemorySubjectIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const MemorySubjectRefSchema = z.object({
  id: MemorySubjectIdSchema,
  type: MemorySubjectTypeSchema,
  label: z.string().min(1).max(200),
});
export const MemorySubjectSchema = MemorySubjectRefSchema.extend({
  /** Short synthesized overview of this page; null until enough is known. */
  summary: z.string().max(1_200).nullable(),
  factCount: z.number().int().nonnegative(),
  lastConfirmedAt: InstantSchema,
});
export type MemorySubject = z.infer<typeof MemorySubjectSchema>;
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
  /** Absent only on facts still waiting for their first consolidation pass. */
  subject: MemorySubjectRefSchema.nullable().optional(),
});
export type PersonalMemory = z.infer<typeof PersonalMemorySchema>;
export const MemoryListRequestSchema = z.object({
  query: z.string().max(500).optional(),
  category: MemoryCategorySchema.optional(),
  /** One memory page. */
  subject: MemorySubjectIdSchema.optional(),
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
export const MemorySubjectsRequestSchema = z.object({}).default({});
export const MemorySubjectsResponseSchema = z.object({
  subjects: z.array(MemorySubjectSchema).max(300),
  /** True while older facts are still being merged into pages. */
  organizing: z.boolean(),
});

/** Chat stays ephemeral. Only an explicitly requested change becomes a memory. */
export const MemoryChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(2_000),
  subject: MemorySubjectIdSchema.optional(),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(2_000) })).max(8).default([]),
});
export const MemoryChatResponseSchema = z.object({
  answer: z.string().min(1).max(2_000),
  memories: z.array(PersonalMemorySchema).max(12),
  changes: z.array(z.object({ kind: z.enum(['saved', 'updated', 'forgotten']), memoryId: z.string().uuid(), text: z.string().max(600) })).max(3),
});

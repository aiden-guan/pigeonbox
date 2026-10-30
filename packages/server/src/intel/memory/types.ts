import { MemoryCategorySchema, MemoryEntitySchema, MemoryKindSchema } from '@pigeonbox/api-contract';
import { z } from 'zod';

/**
 * Who a fact is about. `self` is the owner (key ignored, one page across every
 * inbox); `person` is keyed by that correspondent's exact email; `topic` by its
 * name (a project, course or organization).
 */
export const SubjectSchema = z.object({
  type: z.enum(['self', 'person', 'topic']),
  key: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(200),
});
export type MemorySubjectInput = z.infer<typeof SubjectSchema>;

export const CandidateSchema = z.object({
  /**
   * add: new information. update: replaces or refines the known fact `ref`.
   * confirm: restates the known fact `ref` (adds a source, nothing else).
   */
  op: z.enum(['add', 'update', 'confirm']),
  /** A known-fact handle from the prompt (k1, k2…) for update/confirm; null for add. */
  ref: z.string().max(12).nullable(),
  subject: SubjectSchema,
  kind: MemoryKindSchema,
  category: MemoryCategorySchema,
  canonicalText: z.string().trim().min(10).max(600),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  usefulness: z.number().min(0).max(1),
  entities: z.array(MemoryEntitySchema).min(1).max(8),
  gmailMessageId: z.string().min(1).max(64),
  /** Exact supporting own-words span; checked in memory, never persisted. */
  evidence: z.string().min(10).max(800),
  sensitivity: z.enum(['ordinary', 'sensitive', 'secret']),
  validFrom: z.string().datetime().nullable(),
  validUntil: z.string().datetime().nullable(),
  temporary: z.boolean(),
  /** A named subject plus one single-valued attribute; null for ambiguous facts. */
  concept: z
    .object({ topic: z.string().min(3).max(120), attribute: z.enum(['date', 'time', 'location', 'role', 'company', 'coverage', 'restriction']) })
    .nullable(),
  explicitUpdate: z.boolean(),
});
export const ExtractionSchema = z.object({ memories: z.array(CandidateSchema).max(8) });
export type MemoryCandidate = z.infer<typeof CandidateSchema>;
export type MemoryEntity = z.infer<typeof MemoryEntitySchema>;
export const StoredContentSchema = z.object({
  text: z.string().min(1).max(600),
  entities: z.array(MemoryEntitySchema).max(12),
  concept: CandidateSchema.shape.concept,
  /** Absent on facts written before memory pages; consolidation fills it in. */
  subject: SubjectSchema.optional(),
});
export type StoredContent = z.infer<typeof StoredContentSchema>;
/** Encrypted page envelope: label plus an optional synthesized overview. */
export const SubjectContentSchema = z.object({
  label: z.string().min(1).max(200),
  key: z.string().min(1).max(200),
  summary: z.string().max(1_200).nullable(),
});
export type SubjectContent = z.infer<typeof SubjectContentSchema>;

export type MemoryRow = {
  id: string;
  kind: MemoryCandidate['kind'];
  category: MemoryCandidate['category'];
  text_key_id: string;
  text_iv: string;
  text_ciphertext: string;
  fingerprint: string;
  scope_key: string;
  subject_type: 'self' | 'person' | 'topic' | null;
  concept_key: string | null;
  importance: number;
  confidence: number;
  valid_from: unknown;
  valid_until: unknown;
  last_confirmed_at: unknown;
  status: 'active' | 'superseded';
  corrected: boolean;
  updated_at: unknown;
};

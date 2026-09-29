import {
  ClassificationResultSchema,
  DraftSuggestionSchema,
  ThreadSummarySchema,
} from '@pigeonbox/shared';
import { z } from 'zod';

/**
 * Cloud AI requests carry the same inputs the extension's `AIProvider` already
 * receives, so the Gmail integration cannot tell where a result came from.
 * Limits cap abuse and cost; the extension trims threads well below them.
 */
export const AI_LIMITS = {
  subjectChars: 998,
  bodyChars: 20_000,
  messages: 50,
  textChars: 20_000,
  askChunks: 12,
  askChunkChars: 4_000,
  queryChars: 2_000,
  embedTexts: 64,
  embedChars: 8_000,
} as const;

const text = (max: number) => z.string().max(max);

export const VoiceProfileSchema = z.object({
  name: text(120),
  about: text(500),
  greeting: text(120),
  signoff: text(120),
  concision: z.enum(['short', 'medium', 'long']),
  capitalization: z.enum(['normal', 'sentence', 'title']),
  formality: z.enum(['casual', 'neutral', 'formal']),
  emoji: z.boolean(),
  schedulingPreference: text(500),
  personalInstructions: text(2_000),
});

const ThreadMessageSchema = z.object({
  sender: text(400),
  bodyText: text(AI_LIMITS.bodyChars),
  timestamp: text(80),
});

export const ClassifyInputSchema = z.object({
  subject: text(AI_LIMITS.subjectChars),
  snippet: text(2_000),
  bodyText: text(AI_LIMITS.bodyChars),
  latestSender: text(400),
  direction: z.enum(['inbound', 'outbound']),
  gmailCategoryHint: text(64).optional(),
  hasListUnsubscribe: z.boolean().optional(),
});

export const SummarizeInputSchema = z.object({
  subject: text(AI_LIMITS.subjectChars),
  messages: z.array(ThreadMessageSchema).min(1).max(AI_LIMITS.messages),
  owner: z.object({ email: text(320), name: text(120).optional() }).optional(),
});

export const DraftInputSchema = z.object({
  subject: text(AI_LIMITS.subjectChars),
  messages: z.array(ThreadMessageSchema).min(1).max(AI_LIMITS.messages),
  owner: z.object({ email: text(320), name: text(120).optional() }).optional(),
  voice: VoiceProfileSchema,
  mode: z.enum(['direct', 'warm', 'short']).optional(),
  kind: z.enum(['reply', 'follow_up']),
});

export const RewriteModeSchema = z.enum([
  'bullets_to_email',
  'improve',
  'shorten',
  'lengthen',
  'simplify',
  'grammar',
  'rewrite_voice',
  'change_tone',
  'draft_follow_up',
  'summarize_then_reply',
]);

export const RewriteInputSchema = z.object({
  text: text(AI_LIMITS.textChars).min(1),
  mode: RewriteModeSchema,
  voice: VoiceProfileSchema.optional(),
  context: text(AI_LIMITS.textChars).optional(),
});

export const AskInputSchema = z.object({
  query: text(AI_LIMITS.queryChars).min(1),
  contextChunks: z
    .array(z.object({ threadId: text(128), subject: text(AI_LIMITS.subjectChars), text: text(AI_LIMITS.askChunkChars) }))
    .max(AI_LIMITS.askChunks),
  coverageNote: text(1_000),
});

export const EmbedInputSchema = z.object({
  texts: z.array(text(AI_LIMITS.embedChars)).min(1).max(AI_LIMITS.embedTexts),
});

export const AskOutputSchema = z.object({
  answer: z.string().max(8_000),
  citations: z.array(z.object({ threadId: z.string().max(128), subject: z.string().max(AI_LIMITS.subjectChars) })).max(24),
  incompleteIndex: z.boolean(),
});

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
});
export type CloudUsage = z.infer<typeof UsageSchema>;

/** Every AI response has the same envelope. `model` is informational. */
function aiResponse<T extends z.ZodTypeAny>(result: T) {
  return z.object({
    result,
    usage: UsageSchema.default({}),
    model: z.string().max(200).optional(),
    requestId: z.string().max(128).optional(),
  });
}

export const ClassifyRequestSchema = z.object({ input: ClassifyInputSchema });
export const SummarizeRequestSchema = z.object({ input: SummarizeInputSchema });
export const DraftRequestSchema = z.object({ input: DraftInputSchema });
export const RewriteRequestSchema = z.object({ input: RewriteInputSchema });
export const AskRequestSchema = z.object({ input: AskInputSchema });
export const EmbedRequestSchema = EmbedInputSchema;

export const ClassifyResponseSchema = aiResponse(ClassificationResultSchema);
export const SummarizeResponseSchema = aiResponse(ThreadSummarySchema);
export const DraftResponseSchema = aiResponse(DraftSuggestionSchema);
export const RewriteResponseSchema = aiResponse(z.string().max(AI_LIMITS.textChars * 2));
export const AskResponseSchema = aiResponse(AskOutputSchema);
export const EmbedResponseSchema = aiResponse(z.array(z.array(z.number())).max(AI_LIMITS.embedTexts));

export type ClassifyRequest = z.infer<typeof ClassifyRequestSchema>;
export type SummarizeRequest = z.infer<typeof SummarizeRequestSchema>;
export type DraftRequest = z.infer<typeof DraftRequestSchema>;
export type RewriteRequest = z.infer<typeof RewriteRequestSchema>;
export type AskRequest = z.infer<typeof AskRequestSchema>;
export type EmbedRequest = z.infer<typeof EmbedRequestSchema>;

/** Operations metered separately. Used for usage rows and rate-limit keys. */
export const AiOperationSchema = z.enum(['classify', 'summarize', 'draft', 'follow_up', 'rewrite', 'ask', 'embed']);
export type AiOperation = z.infer<typeof AiOperationSchema>;

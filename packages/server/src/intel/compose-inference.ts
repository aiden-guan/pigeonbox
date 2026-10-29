import { z } from 'zod';
import { ComposeJudgmentSchema } from './compose-context.js';
import { CompletionJudgmentSchema } from './compose-completion-schema.js';
import { WritingJudgmentSchema } from './compose-writing.js';

/** The model selects a supplied sentence instead of spending tokens copying it.
 * The public response and all existing grounding checks stay the same. */
export const ComposeInferenceSchema = z.object({
  advisory: z.object({
    kind: ComposeJudgmentSchema.shape.kind,
    confidence: ComposeJudgmentSchema.shape.confidence,
    sourceIds: ComposeJudgmentSchema.shape.sourceIds,
    advisoryIndex: z.number().int().min(0).max(2),
    suggestedText: ComposeJudgmentSchema.shape.suggestedText,
    highlightText: z.string().max(160).nullable(),
  }).nullable(),
  completion: CompletionJudgmentSchema.nullable(),
  writing: WritingJudgmentSchema.nullable().optional(),
});

export type ComposePromptEvidence = { id: string; advisories?: string[] };

export function expandComposeInference(value: z.infer<typeof ComposeInferenceSchema>, evidence: ComposePromptEvidence[]): z.infer<typeof ComposeJudgmentSchema> {
  const advisory = value.advisory;
  const message = advisory && evidence.find(item => item.id === advisory.sourceIds[0])?.advisories?.[advisory.advisoryIndex];
  return {
    surface: Boolean(message),
    kind: advisory?.kind ?? 'context',
    confidence: advisory?.confidence ?? 0,
    sourceIds: advisory?.sourceIds ?? [],
    message: message ?? '',
    suggestedText: advisory?.suggestedText ?? null,
    highlightText: advisory?.highlightText ?? null,
    completion: value.completion,
    writing: value.writing,
  };
}

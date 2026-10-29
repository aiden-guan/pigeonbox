import { z } from 'zod';

export const CompletionJudgmentSchema = z.object({
  text: z.string().min(1).max(240),
  confidence: z.number().min(0).max(1),
  kind: z.enum(['grounded', 'writing']).optional(),
  proofs: z.array(z.object({ sourceId: z.string().max(8), quote: z.string().min(8).max(400) })).max(4),
}).superRefine((value, ctx) => {
  if (value.kind !== 'writing' && !value.proofs.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Factual completions require proof', path: ['proofs'] });
  if (value.kind === 'writing' && value.proofs.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Writing completions must not cite facts', path: ['proofs'] });
});

export const COMPLETION_INSTRUCTIONS = `Consider ONE short, natural continuation when the writer has left a useful thought unfinished. The writer has not accepted anything yet.
Use judgment about the meaning of this particular thought, its recipient and the available context. This is not a phrase catalog: a useful detail may come from an earlier email, a decision, a plan, a person's role, a project, a deadline, or another durable fact the writer would otherwise have to recall. A current-thread or recipient link can establish relevance even when wording differs; still confirm that every fact you add concerns this same topic and person. Preserve the writer's voice, person, tense and intent. Return only the NEW suffix, with the leading space or punctuation it needs, maximum 240 characters. Do not repeat or rewrite the prefix.
Add only detail directly supported by the supplied evidence. An explicitly corrected writing preference may guide phrasing, but do not repeat it as message content unless the prefix clearly makes that preference relevant. For an unfinished clause, prefer a useful continuation over repeating the same fact as helpful_context. When the prefix agrees with a memory and that memory supplies the next detail, set surface:false and put the new detail in completion. Do not complete merely to be chatty. Never invent achievements, revenue, people, dates or intent. Do not add promises, new commitments, opinions, medical/financial identifiers, links, salutations, signatures or recipient actions. A revenue number is not profit; an outcome for another person is not the writer's outcome. If evidence conflicts, is ambiguous, the prefix is already a complete thought, or there is no useful missing detail, return completion:null. Prioritize a factual warning over a continuation.
completion: null or {text:string,confidence:number,kind:"grounded",proofs:[{sourceId:"E1",quote:string}]}. Each quote must be an EXACT substring of a supplied evidence item's text and establish every added fact. Every selected source must be relevant to the SAME entity and topic. Numbers must retain the exact value, unit and meaning; equivalent shorthand is fine. No evidence means no factual completion. Confidence must be >=0.9.`;

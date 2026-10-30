import { MockInferenceBackend, type ChatRequest, type InferenceContext } from '../ai/backends.js';
import { readDataBlock } from '../intel/prompts.js';
import type { MemoryCandidate } from '../intel/memory/types.js';
const PROFESSOR = 'professor@berkeley.test';
const fact = 'Midterm 2 covers through Chapter 8. Calculators are not allowed.';
export const SELF_FACT = 'Freshman at UC Berkeley studying business and data science.';
function candidate(patch: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    op: 'add',
    ref: null,
    subject: { type: 'person', key: PROFESSOR, label: 'Professor Smith' },
    kind: 'episodic',
    category: 'classes',
    canonicalText: fact,
    importance: 0.9,
    confidence: 0.9,
    usefulness: 0.9,
    entities: [
      { type: 'email', key: PROFESSOR },
      { type: 'course', key: 'MATH 52' },
    ],
    gmailMessageId: 'abc123',
    evidence: fact,
    sensitivity: 'ordinary',
    validFrom: null,
    validUntil: null,
    temporary: true,
    concept: null,
    explicitUpdate: false,
    ...patch,
  };
}
/** Controlled imperfect extraction provider. Gmail, SQL, RLS, encryption,
 * queues, API routing and grounding are the actual implementations. */
export class MemoryFixtureAI extends MockInferenceBackend {
  drafts: ChatRequest[] = [];
  publicDrafts: ChatRequest[] = [];
  extractionCalls = 0;
  consolidationCalls = 0;
  /** Known-fact lines the last extraction prompt carried. */
  lastKnown: string[] = [];
  embeds: string[][] = [];
  override async chat(request: ChatRequest, context: InferenceContext) {
    if (context.operation === 'memory_extract') {
      this.extractionCalls += 1;
      const input = JSON.parse(request.messages.find((part) => part.role === 'user')!.content) as {
        owner: string;
        known: string[];
        messages: Array<{ gmailMessageId: string; from: string; to: string[]; text: string }>;
      };
      this.lastKnown = input.known;
      const memories = input.messages.flatMap((source) => {
        const outbound = source.from === input.owner;
        // "Legacy" mode reproduces the old per-recipient behavior: the owner's fact filed under whoever they emailed.
        const legacy = source.text.match(/\[legacy\] (Aiden says he is a freshman at UC Berkeley studying business and data science\.)/);
        if (legacy)
          return [
            candidate({
              canonicalText: legacy[1]!,
              evidence: legacy[1]!,
              gmailMessageId: source.gmailMessageId,
              subject: { type: 'person', key: source.to[0]!, label: source.to[0]! },
              entities: [{ type: 'email', key: source.to[0]! }],
              kind: 'semantic',
              temporary: false,
              category: 'classes',
            }),
          ];
        // A shorter statement of the owner's fact that this model always adds as new.
        const short = source.text.match(/I'm a freshman at UC Berkeley\.(?! studying)/);
        if (short && !/studying/.test(source.text))
          return [
            candidate({
              canonicalText: 'Freshman at UC Berkeley.',
              evidence: short[0],
              gmailMessageId: source.gmailMessageId,
              subject: { type: 'self', key: 'self', label: 'You' },
              entities: [{ type: 'email', key: source.to[0]! }],
              kind: 'semantic',
              temporary: false,
              category: 'classes',
            }),
          ];
        const self = source.text.match(/I(?:'m| am) a freshman at (?:UC )?Berkeley,? studying business and data science\./);
        if (self) {
          // Like a good model: a fact KNOWN already lists is confirmed, not added again,
          // except the "at Berkeley" wording, which this model fails to recognize.
          const known = input.known.find((line) => line.endsWith(`| ${SELF_FACT}`));
          const reworded = !/UC Berkeley/.test(self[0]);
          return [
            candidate({
              op: known && !reworded ? 'confirm' : 'add',
              ref: known && !reworded ? known.split(' | ')[0]! : null,
              canonicalText: reworded ? 'Freshman at Berkeley studying business and data science.' : SELF_FACT,
              evidence: self[0],
              gmailMessageId: source.gmailMessageId,
              subject: { type: 'self', key: 'self', label: 'You' },
              entities: [{ type: 'email', key: source.to[0]! }],
              kind: 'semantic',
              temporary: false,
              category: 'classes',
            }),
          ];
        }
        const goal = source.text.match(/I want to work at Multifactor this summer\./);
        if (goal)
          return [
            candidate({
              canonicalText: 'Wants to work at Multifactor this summer.',
              evidence: goal[0],
              gmailMessageId: source.gmailMessageId,
              subject: { type: 'self', key: 'self', label: 'You' },
              entities: [{ type: 'company', key: 'Multifactor' }],
              kind: 'goal',
              temporary: false,
              category: 'decisions',
            }),
          ];
        const built = source.text.match(/I built PigeonBox, an AI email copilot\./);
        if (built)
          return [
            candidate({
              canonicalText: 'Built PigeonBox, an AI email copilot.',
              evidence: built[0],
              gmailMessageId: source.gmailMessageId,
              subject: { type: 'self', key: 'self', label: 'You' },
              entities: [{ type: 'project', key: 'PigeonBox' }],
              kind: 'semantic',
              temporary: false,
              category: 'projects',
            }),
          ];
        let text: string | null = null;
        let concept: MemoryCandidate['concept'] = null;
        let explicitUpdate = false;
        if (source.text.includes(fact)) text = fact;
        const date = source.text.match(/Midterm 2 (?:has been moved to|is) October (14|16)\./);
        if (date) {
          text = date[0];
          concept = { topic: 'Midterm 2', attribute: 'date' };
          explicitUpdate = /moved/.test(text);
        }
        if (source.text.includes('Professor Smith teaches MATH 52.')) text = 'Professor Smith teaches MATH 52.';
        if (!text) return [];
        return [
          candidate({
            canonicalText: text,
            evidence: text,
            gmailMessageId: source.gmailMessageId,
            subject: outbound ? { type: 'person', key: source.to[0]!, label: source.to[0]! } : { type: 'person', key: source.from, label: 'Professor Smith' },
            entities: [{ type: 'email', key: outbound ? source.to[0]! : source.from }],
            concept,
            explicitUpdate,
            kind: /teaches/.test(text) ? 'semantic' : 'episodic',
            temporary: !/teaches/.test(text),
          }),
        ];
      });
      return { text: JSON.stringify({ memories }), model: 'fixture', provider: 'mock', serviceTier: request.serviceTier, usage: { inputTokens: 20, outputTokens: 30 } };
    }
    if (context.operation === 'memory_consolidate') {
      this.consolidationCalls += 1;
      const input = JSON.parse(request.messages.find((part) => part.role === 'user')!.content) as {
        facts?: Array<{ ref: string; text: string; people: string[] }>;
        pages?: Array<{ page: string; about: string; facts: string[] }>;
      };
      const reply = (value: unknown) => ({ text: JSON.stringify(value), model: 'fixture', provider: 'mock', serviceTier: request.serviceTier, usage: { inputTokens: 40, outputTokens: 40 } });
      if (input.facts)
        return reply({
          facts: input.facts.map((fact) =>
            /freshman/i.test(fact.text)
              ? { ref: fact.ref, subject: { type: 'self', key: 'self', label: 'You' }, text: SELF_FACT }
              : { ref: fact.ref, subject: { type: 'person', key: fact.people[0] ?? 'nobody@example.test', label: 'Someone' }, text: fact.text },
          ),
        });
      return reply({
        pages: (input.pages ?? []).map((page) => {
          const facts = page.facts.map((line) => ({ ref: line.slice(0, line.indexOf(':')), text: line.slice(line.indexOf(':') + 2) }));
          const norm = (text: string) => text.toLowerCase().replace(/\bat (?:uc )?berkeley\b/, 'at berkeley').replace(/[^a-z0-9]+/g, ' ').trim();
          const duplicates = facts.flatMap((fact, i) => {
            const drop = facts.slice(i + 1).filter((other) => norm(other.text) === norm(fact.text) && facts.findIndex((first) => norm(first.text) === norm(fact.text)) === i);
            return drop.length ? [{ keep: fact.ref, drop: drop.map((other) => other.ref) }] : [];
          });
          const unique = facts.filter((fact, i) => facts.findIndex((first) => norm(first.text) === norm(fact.text)) === i);
          return { page: page.page, duplicates, summary: unique.length >= 3 ? `In short: ${unique.map((fact) => fact.text).join(' ')}` : null };
        }),
      });
    }
    if (context.operation === 'grounded_draft') {
      this.drafts.push(request);
      if (request.messages.some((part) => part.content.includes('Derived fact from prior communication') && part.content.includes('Chapter 8'))) {
        return {
          text: JSON.stringify({
            variants: [
              {
                label: 'recommended',
                strategy: 'Ask about the remembered exam',
                body: 'Hi Professor Smith,\n\nYou mentioned Midterm 2 covers through Chapter 8 and calculators are not allowed. Could I ask a question about October 25 and $900?\n\nThanks,\nAda',
                usedSources: [
                  'S1',
                  ...(readDataBlock(request.messages.at(-1)!.content) as { sources: Array<{ id: string; text: string }> }).sources
                    .filter((source) => source.text.includes('Derived fact from prior communication') && source.text.includes('Chapter 8'))
                    .map((source) => source.id),
                ],
              },
            ],
            missingFacts: [],
            confidence: 0.9,
          }),
          model: 'fixture',
          provider: 'mock',
          serviceTier: request.serviceTier,
          usage: { inputTokens: 20, outputTokens: 30 },
        };
      }
    }
    if (context.operation === 'draft' || context.operation === 'follow_up') {
      this.publicDrafts.push(request);
      if (request.messages.some((part) => part.content.includes('UNTRUSTED PERSONAL CONTEXT') && part.content.includes('Chapter 8'))) {
        return {
          text: JSON.stringify({
            mode: 'direct',
            body: 'Hi Professor Smith,\n\nYou mentioned Midterm 2 covers through Chapter 8 and calculators are not allowed. Could I ask a question about October 25?\n\nThanks,\nAda',
            placeholders: [],
            confidence: 0.9,
          }),
          model: 'fixture',
          provider: 'mock',
          serviceTier: request.serviceTier,
          usage: { inputTokens: 20, outputTokens: 30 },
        };
      }
    }
    return super.chat(request, context);
  }
  override async embed(texts: string[], context: InferenceContext) {
    this.embeds.push(texts);
    return super.embed(texts, context);
  }
}

/** Controlled proposal-delivery reasoning for reconciliation/UI fixtures. */
export class PromiseFixtureAI extends MemoryFixtureAI {
  override async chat(request: ChatRequest, context: InferenceContext) {
    const data = readDataBlock(request.messages.at(-1)!.content) as { task?: string; promises?: Array<{ref:string;text:string}>; messages?: Array<{ref:string;attachments:string[];text:string}> } | null;
    if (data?.task === 'commitment_reconcile') {
      const delivery = data.messages?.find((message) => message.attachments.includes('proposal.pdf') && /proposal/i.test(message.text));
      const promise = data.promises?.find((promise) => /proposal/i.test(promise.text));
      return { text: JSON.stringify({resolutions: delivery && promise ? [{ref:promise.ref,message:delivery.ref,status:'done',confidence:0.98,evidence:'proposal.pdf'}] : []}), model:'fixture',provider:'mock',serviceTier:request.serviceTier,usage:{inputTokens:20,outputTokens:30} };
    }
    return super.chat(request,context);
  }
}

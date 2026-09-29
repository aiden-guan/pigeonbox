import {
  ClassificationResultSchema,
  DraftSuggestionSchema,
  NeedsReplyResultSchema,
  ThreadSummarySchema,
  type ClassificationResult,
  type DraftSuggestion,
  type NeedsReplyResult,
  type ThreadSummary,
  type VoiceProfile,
} from '@pigeonbox/shared';
import { z } from 'zod';
import { EMAIL_SUMMARY_SYSTEM_PROMPT, formatThreadForSummary, summaryUserContent } from './summary-prompt.js';
import { coerceDraftSuggestion, coerceThreadSummary } from './prompt-provider.js';
import { draftQualityIssue, draftSystemPrompt, finishDraft, formatDraftContext } from './draft-prompt.js';

export type ClassifyInput = {
  subject: string;
  snippet: string;
  bodyText: string;
  latestSender: string;
  direction: 'inbound' | 'outbound';
  gmailCategoryHint?: string;
  hasListUnsubscribe?: boolean;
};

export type SummarizeInput = {
  subject: string;
  /** `sender` is an address or `Name <address>`. */
  messages: Array<{ sender: string; bodyText: string; timestamp: string }>;
  owner?: MailboxOwner;
};

/** The Gmail account the draft is written from. */
export type MailboxOwner = { email: string; name?: string };

export type DraftInput = {
  subject: string;
  /** `sender` is an address or `Name <address>`. */
  messages: Array<{ sender: string; bodyText: string; timestamp: string }>;
  owner?: MailboxOwner;
  voice: VoiceProfile;
  mode?: 'direct' | 'warm' | 'short';
  kind: 'reply' | 'follow_up';
};

export type RewriteInput = {
  text: string;
  mode:
    | 'bullets_to_email'
    | 'improve'
    | 'shorten'
    | 'lengthen'
    | 'simplify'
    | 'grammar'
    | 'rewrite_voice'
    | 'change_tone'
    | 'draft_follow_up'
    | 'summarize_then_reply';
  voice?: VoiceProfile;
  context?: string;
};

export type AskInput = {
  query: string;
  contextChunks: Array<{ threadId: string; subject: string; text: string }>;
  coverageNote: string;
};

export type AskOutput = {
  answer: string;
  citations: Array<{ threadId: string; subject: string }>;
  incompleteIndex: boolean;
};

export type UsageStats = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export interface AIProvider {
  readonly name: string;
  classifyEmail(input: ClassifyInput): Promise<{ result: ClassificationResult; usage?: UsageStats }>;
  summarizeThread(input: SummarizeInput): Promise<{ result: ThreadSummary; usage?: UsageStats }>;
  draftReply(input: DraftInput): Promise<{ result: DraftSuggestion; usage?: UsageStats }>;
  draftFollowUp(input: DraftInput): Promise<{ result: DraftSuggestion; usage?: UsageStats }>;
  rewriteText(input: RewriteInput): Promise<{ result: string; usage?: UsageStats }>;
  answerMailboxQuery(input: AskInput): Promise<{ result: AskOutput; usage?: UsageStats }>;
  embed(texts: string[]): Promise<{ vectors: number[][]; usage?: UsageStats }>;
}

export type ProviderConfig = {
  apiKey: string;
  model: string;
  endpoint: string;
  embedModel?: string;
};

const AskOutputSchema = z.object({
  answer: z.string(),
  citations: z.array(z.object({ threadId: z.string(), subject: z.string() })),
  incompleteIndex: z.boolean(),
});

export abstract class OpenAICompatibleProvider implements AIProvider {
  abstract readonly name: string;

  constructor(protected readonly config: ProviderConfig) {}

  protected async chatJson<T>(
    system: string,
    user: string,
    schema: z.ZodType<T>,
  ): Promise<{ data: T; usage?: UsageStats }> {
    const res = await fetch(`${trimSlash(this.config.endpoint)}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (res.status === 429) {
      const err = new Error('rate_limited');
      (err as Error & { retryable: boolean }).retryable = true;
      throw err;
    }
    if (!res.ok) {
      throw new Error(`AI provider error ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error('empty AI response');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('AI returned non-JSON');
    }
    const data = schema.parse(parsed);
    return {
      data,
      usage: {
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
        totalTokens: json.usage?.total_tokens,
      },
    };
  }

  async classifyEmail(input: ClassifyInput) {
    const { data, usage } = await this.chatJson(
      'You classify emails. Return JSON only matching the schema. Be concise. No chain-of-thought.',
      JSON.stringify(input),
      ClassificationResultSchema,
    );
    return { result: data, usage };
  }

  async summarizeThread(input: SummarizeInput) {
    const formatted = formatThreadForSummary({
      subject: input.subject,
      messages: input.messages.slice(-8).map((message) => ({
        sender: message.sender,
        timestamp: message.timestamp,
        bodyText: message.bodyText.slice(0, 4000),
      })),
      owner: input.owner,
    });
    const { data, usage } = await this.chatJson(
      EMAIL_SUMMARY_SYSTEM_PROMPT,
      summaryUserContent(formatted),
      z.preprocess(coerceThreadSummary, ThreadSummarySchema) as z.ZodType<ThreadSummary>,
    );
    return { result: data, usage };
  }

  async draftReply(input: DraftInput): Promise<{ result: DraftSuggestion; usage?: UsageStats }> {
    const { data, usage } = await this.chatJson(
      draftSystemPrompt(input, 'reply'),
      formatDraftContext(input, 'reply', 'full', 24_000),
      z.preprocess(coerceDraftSuggestion, DraftSuggestionSchema) as z.ZodType<DraftSuggestion>,
    );
    const body = finishDraft(data.body, input);
    const qualityIssue = draftQualityIssue(input.messages, body, input.owner, input.voice);
    if (qualityIssue) throw new Error(qualityIssue);
    return {
      result: {
        mode: data.mode ?? 'direct',
        body,
        placeholders: data.placeholders ?? [],
        subject: data.subject,
        confidence: data.confidence,
      },
      usage,
    };
  }

  async draftFollowUp(input: DraftInput): Promise<{ result: DraftSuggestion; usage?: UsageStats }> {
    const { data, usage } = await this.chatJson(
      draftSystemPrompt(input, 'follow_up'),
      formatDraftContext(input, 'follow_up', 'full', 24_000),
      z.preprocess(coerceDraftSuggestion, DraftSuggestionSchema) as z.ZodType<DraftSuggestion>,
    );
    const body = finishDraft(data.body, input, 'follow_up');
    const qualityIssue = draftQualityIssue(input.messages, body, input.owner, input.voice);
    if (qualityIssue) throw new Error(qualityIssue);
    return {
      result: {
        mode: data.mode ?? 'direct',
        body,
        placeholders: data.placeholders ?? [],
        subject: data.subject,
        confidence: data.confidence,
      },
      usage,
    };
  }

  async rewriteText(input: RewriteInput) {
    const schema = z.object({ text: z.string() });
    const { data, usage } = await this.chatJson(
      `Rewrite email text. Mode=${input.mode}. Preserve meaning. Return JSON {text}.`,
      JSON.stringify(input),
      schema,
    );
    return { result: data.text, usage };
  }

  async answerMailboxQuery(input: AskInput) {
    const { data, usage } = await this.chatJson(
      `Answer ONLY from provided mailbox context. Every factual claim needs citations. If incomplete, set incompleteIndex true and say the local index may be incomplete. Coverage: ${input.coverageNote}`,
      JSON.stringify({ query: input.query, contextChunks: input.contextChunks }),
      AskOutputSchema,
    );
    return { result: data, usage };
  }

  async embed(texts: string[]) {
    const res = await fetch(`${trimSlash(this.config.endpoint)}/embeddings`, {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.embedModel || 'text-embedding-3-small',
        input: texts,
      }),
    });
    if (res.status === 429) {
      const err = new Error('rate_limited');
      (err as Error & { retryable: boolean }).retryable = true;
      throw err;
    }
    if (!res.ok) throw new Error(`embed error ${res.status}`);
    const json = (await res.json()) as {
      data: Array<{ embedding: number[] }>;
      usage?: { total_tokens?: number };
    };
    return {
      vectors: json.data.map((d) => d.embedding),
      usage: { totalTokens: json.usage?.total_tokens },
    };
  }
}

export class OpenAIProvider extends OpenAICompatibleProvider {
  readonly name = 'openai';
}

export class OpenAICompatibleEndpointProvider extends OpenAICompatibleProvider {
  readonly name = 'openai-compatible';
}

export class OllamaProvider extends OpenAICompatibleProvider {
  readonly name = 'ollama';
  constructor(config: ProviderConfig) {
    super({
      ...config,
      apiKey: config.apiKey || 'ollama',
      endpoint: config.endpoint || 'http://127.0.0.1:11434/v1',
    });
  }
}

/** Interface stubs — selectable when implemented with provider-specific APIs. */
export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  constructor(private readonly config: ProviderConfig) {}
  private unsupported(): never {
    throw new Error(
      'Anthropic provider interface is defined but not fully implemented. Use OpenAI / OpenAI-compatible / Ollama.',
    );
  }
  classifyEmail() {
    return this.unsupported();
  }
  summarizeThread() {
    return this.unsupported();
  }
  draftReply() {
    return this.unsupported();
  }
  draftFollowUp() {
    return this.unsupported();
  }
  rewriteText() {
    return this.unsupported();
  }
  answerMailboxQuery() {
    return this.unsupported();
  }
  embed() {
    return this.unsupported();
  }
}

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini';
  constructor(private readonly config: ProviderConfig) {}
  private unsupported(): never {
    throw new Error(
      'Gemini provider interface is defined but not fully implemented. Use OpenAI / OpenAI-compatible / Ollama.',
    );
  }
  classifyEmail() {
    return this.unsupported();
  }
  summarizeThread() {
    return this.unsupported();
  }
  draftReply() {
    return this.unsupported();
  }
  draftFollowUp() {
    return this.unsupported();
  }
  rewriteText() {
    return this.unsupported();
  }
  answerMailboxQuery() {
    return this.unsupported();
  }
  embed() {
    return this.unsupported();
  }
}

export class DisabledAIProvider implements AIProvider {
  readonly name = 'disabled';
  async classifyEmail(): Promise<{ result: ClassificationResult }> {
    throw new Error('AI disabled');
  }
  async summarizeThread(): Promise<{ result: ThreadSummary }> {
    throw new Error('AI disabled');
  }
  async draftReply(): Promise<{ result: DraftSuggestion }> {
    throw new Error('AI disabled');
  }
  async draftFollowUp(): Promise<{ result: DraftSuggestion }> {
    throw new Error('AI disabled');
  }
  async rewriteText(): Promise<{ result: string }> {
    throw new Error('AI disabled');
  }
  async answerMailboxQuery(): Promise<{ result: AskOutput }> {
    throw new Error('AI disabled');
  }
  async embed(): Promise<{ vectors: number[][] }> {
    throw new Error('AI disabled');
  }
}

export function createAIProvider(
  kind: 'openai' | 'anthropic' | 'gemini' | 'openai-compatible' | 'ollama' | 'disabled',
  config: ProviderConfig,
): AIProvider {
  switch (kind) {
    case 'openai':
      return new OpenAIProvider(config);
    case 'openai-compatible':
      return new OpenAICompatibleEndpointProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'gemini':
      return new GeminiProvider(config);
    default:
      return new DisabledAIProvider();
  }
}

/** Cost / concurrency control queue with fingerprint cache. */
export class AIJobQueue {
  private queues: Record<string, Promise<unknown>> = {
    classify: Promise.resolve(),
    summary: Promise.resolve(),
    draft: Promise.resolve(),
    embed: Promise.resolve(),
  };
  private inflight: Record<string, number> = {
    classify: 0,
    summary: 0,
    draft: 0,
    embed: 0,
  };
  private readonly limits = { classify: 2, summary: 1, draft: 1, embed: 2 };
  private cache = new Map<string, unknown>();
  usageToday = {
    classifications: 0,
    summaries: 0,
    drafts: 0,
    embeddings: 0,
    estimatedTokens: 0,
    day: new Date().toISOString().slice(0, 10),
  };

  private rollDay(): void {
    const d = new Date().toISOString().slice(0, 10);
    if (d !== this.usageToday.day) {
      this.usageToday = {
        classifications: 0,
        summaries: 0,
        drafts: 0,
        embeddings: 0,
        estimatedTokens: 0,
        day: d,
      };
    }
  }

  getCached<T>(fingerprint: string, kind: string): T | undefined {
    return this.cache.get(`${kind}:${fingerprint}`) as T | undefined;
  }

  setCached(fingerprint: string, kind: string, value: unknown): void {
    this.cache.set(`${kind}:${fingerprint}`, value);
  }

  clearCache(): void {
    this.cache.clear();
  }

  async enqueue<T>(
    kind: 'classify' | 'summary' | 'draft' | 'embed',
    fingerprint: string | null,
    fn: (signal?: AbortSignal) => Promise<T>,
    options?: { bypassCache?: boolean; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T> {
    this.rollDay();
    if (fingerprint && !options?.bypassCache) {
      const hit = this.getCached<T>(fingerprint, kind);
      if (hit !== undefined) return hit;
    }

    const run = async (): Promise<T> => {
      while (this.inflight[kind]! >= this.limits[kind]!) {
        await sleep(50);
      }
      this.inflight[kind]! += 1;
      try {
        let attempt = 0;
        for (;;) {
          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout> | null = null;
          let timedOut = false;

          const onParentAbort = () => {
            controller.abort(options?.signal?.reason);
          };
          if (options?.signal) {
            if (options.signal.aborted) {
              controller.abort(options.signal.reason);
            } else {
              options.signal.addEventListener('abort', onParentAbort, { once: true });
            }
          }

          try {
            const timeoutMs = options?.timeoutMs ?? 25_000;
            const timeoutPromise = new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                controller.abort(new Error(`AI job ${kind} timed out`));
                reject(new Error(`AI job ${kind} timed out`));
              }, timeoutMs);
            });

            const result = await Promise.race([
              fn(controller.signal),
              timeoutPromise,
            ]);

            if (timer) clearTimeout(timer);
            if (options?.signal) options.signal.removeEventListener('abort', onParentAbort);

            // If timed out or aborted, do not cache or update usage stats
            if (!timedOut && !controller.signal.aborted) {
              if (fingerprint) this.setCached(fingerprint, kind, result);
              if (kind === 'classify') this.usageToday.classifications += 1;
              if (kind === 'summary') this.usageToday.summaries += 1;
              if (kind === 'draft') this.usageToday.drafts += 1;
              if (kind === 'embed') this.usageToday.embeddings += 1;
            }
            return result;
          } catch (e) {
            if (timer) clearTimeout(timer);
            if (options?.signal) options.signal.removeEventListener('abort', onParentAbort);

            // If timed out or explicitly aborted by caller, do not retry
            if (timedOut || options?.signal?.aborted) {
              throw e;
            }

            const retryable = (e as { retryable?: boolean; message?: string }).retryable
              || String((e as Error).message || '').includes('rate_limited');
            if (!retryable || attempt >= 5) throw e;
            attempt += 1;
            await sleep(Math.min(1000 * 2 ** attempt, 30_000));
          }
        }
      } finally {
        this.inflight[kind]! -= 1;
      }
    };

    const next = this.queues[kind]!.then(run, run);
    this.queues[kind] = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function trimSlash(s: string): string {
  return s.replace(/\/$/, '');
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { NeedsReplyResultSchema };
export type { NeedsReplyResult };
export {
  CHATGPT_CONVERSATION_URL,
  CHATGPT_DEFAULT_MODEL,
  CHATGPT_MODELS,
  CHATGPT_SESSION_URL,
  ChatGptAuthError,
  ChatGptHttpError,
  buildChatGptConversationBody,
  buildChatGptConversationRequest,
  chatGptTextFromHttp,
  decodeChatGptIdentity,
  fetchChatGptWebSession,
  isChatGptModel,
  isChatGptSessionStale,
  parseChatGptConversationSse,
  requestChatGptText,
  sessionFromChatGptAuth,
} from './chatgpt.js';
export type { ChatGptIdentity, ChatGptSession } from './chatgpt.js';
export {
  LOCAL_MODEL_ORIGINS,
  LOCAL_MODELS,
  downloadedLocalDtype,
  formatDownloadSize,
  getLocalModel,
  localModelBytes,
  localModelCacheName,
  localModelDtypes,
  localModelIsDownloaded,
  localModelWeightMarker,
} from './local-models.js';
export type { LocalDtype, LocalModel, LocalModelVendor } from './local-models.js';
export { createPromptBackedProvider, extractJsonObject } from './prompt-provider.js';
export type { PromptComplete, PromptOptions, PromptPriority } from './prompt-provider.js';
export type { ChatExample } from './draft-prompt.js';
export { draftNeedsRefresh, draftQualityIssue } from './draft-prompt.js';

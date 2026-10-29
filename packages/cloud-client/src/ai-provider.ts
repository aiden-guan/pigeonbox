import type { AIProvider, AskInput, ClassifyInput, DraftInput, RewriteInput, SummarizeInput, UsageStats } from '@pigeonbox/ai';
import type { CloudUsage } from '@pigeonbox/api-contract';
import type { PigeonBoxCloudClient } from './client.js';

function usage(value: CloudUsage | undefined): UsageStats | undefined {
  if (!value) return undefined;
  return {
    promptTokens: value.inputTokens,
    completionTokens: value.outputTokens,
    totalTokens: value.totalTokens,
  };
}

/**
 * A PigeonBox server as an `AIProvider`. Inference runs on that server; the
 * caller sees the same results as from a local model.
 *
 * Failures surface as `CloudApiError`. This provider never retries against
 * another backend: falling back to a different remote provider would send the
 * user's mail somewhere they did not choose.
 */
export function createCloudAIProvider(client: PigeonBoxCloudClient): AIProvider {
  return {
    name: 'pigeonbox-cloud',
    async classifyEmail(input: ClassifyInput) {
      const response = await client.call('classify', { input });
      return { result: response.result, usage: usage(response.usage) };
    },
    async summarizeThread(input: SummarizeInput) {
      const response = await client.call('summarize', { input });
      return { result: response.result, usage: usage(response.usage) };
    },
    async draftReply(input: DraftInput) {
      const response = await client.call('draft', { input: { ...input, kind: 'reply' } });
      return { result: response.result, usage: usage(response.usage) };
    },
    async draftFollowUp(input: DraftInput) {
      const response = await client.call('followUp', { input: { ...input, kind: 'follow_up' } });
      return { result: response.result, usage: usage(response.usage) };
    },
    async rewriteText(input: RewriteInput) {
      const response = await client.call('rewrite', { input });
      return { result: response.result, usage: usage(response.usage) };
    },
    async answerMailboxQuery(input: AskInput) {
      const response = await client.call('ask', { input });
      return { result: response.result, usage: usage(response.usage) };
    },
    async embed(texts: string[]) {
      const response = await client.call('embed', { texts });
      return { vectors: response.result, usage: usage(response.usage) };
    },
  };
}

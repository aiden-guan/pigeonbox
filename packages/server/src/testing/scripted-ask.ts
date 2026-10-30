import type { ChatRequest, ChatResult } from '../ai/backends.js';

/** Explicit approval fixture for tests exercising an already-authorized action. */
export function allowScriptedAskAction(request: ChatRequest): ChatResult | undefined {
  if (!request.responseFormat || !request.messages.at(-1)?.content.includes('"task":"ask_action_review"')) return;
  return { text: JSON.stringify({ allowed: true, reason: 'The fixture explicitly requests this action.', missing: [] }), model: 'scripted', provider: 'mock', serviceTier: request.serviceTier, usage: { inputTokens: 10, outputTokens: 10 } };
}

/**
 * Extension-level AI provider selection.
 *
 * This module does not implement "PigeonBox Intelligence" as a separate
 * service. It chooses the `AIProvider` used by the rest of PigeonBox from the
 * run mode (Local or Cloud), settings and build capabilities:
 * on-device (WebGPU Qwen, Gemini Nano), Ollama, BYOK, the experimental ChatGPT
 * session, or PigeonBox Cloud via `@pigeonbox/cloud-client`.
 */
import {
  CHATGPT_DEFAULT_MODEL,
  createAIProvider,
  createPromptBackedProvider,
  isChatGptModel,
  type AIProvider,
  type PromptComplete,
} from '@pigeonbox/ai';
import { CloudApiError, cloudErrorMessage, createCloudAIProvider, type PigeonBoxCloudClient } from '@pigeonbox/cloud-client';
import type { ExtensionSettings } from '@pigeonbox/shared';

export type AIProviderRouterDeps = {
  completeChatGpt: (model: string, system: string, user: string) => ReturnType<PromptComplete>;
  completeOnDevice: (modelId: string, ...args: Parameters<PromptComplete>) => ReturnType<PromptComplete>;
  /** Null when this build has no Cloud URL. */
  cloudClient: () => PigeonBoxCloudClient | null;
  /** Experimental providers (ChatGPT web session) are excluded from release builds. */
  experimental: boolean;
};

/**
 * The single place that decides which `AIProvider` serves a request.
 * Everything downstream (agent, Ask Pigeon, Write with AI, Gmail UI) only sees an
 * `AIProvider` and cannot tell Qwen, Gemini Nano, Ollama, a BYOK key or
 * PigeonBox Cloud apart.
 *
 * Cloud mode never falls back to another remote provider. When Cloud cannot
 * serve a request, the caller gets a clear error and on-device heuristics keep
 * working.
 */
export function resolveAIProvider(settings: ExtensionSettings, deps: AIProviderRouterDeps): AIProvider | null {
  if (settings.runMode === 'cloud') return cloudProvider(deps.cloudClient());
  return resolveLocalProvider(settings, deps);
}

export function resolveLocalProvider(settings: ExtensionSettings, deps: AIProviderRouterDeps): AIProvider | null {
  if (settings.aiMode === 'disabled') return null;
  if (settings.aiProvider === 'chatgpt') {
    if (!deps.experimental) return null;
    const model = isChatGptModel(settings.aiModel) ? settings.aiModel : CHATGPT_DEFAULT_MODEL;
    return createPromptBackedProvider('chatgpt', (system, user) => deps.completeChatGpt(model, system, user), {
      maxUserChars: 48_000,
    });
  }
  if (settings.aiProvider === 'local') {
    return createPromptBackedProvider(
      'local',
      (system, user, options) => deps.completeOnDevice(settings.aiModel, system, user, options),
      { maxUserChars: 4_000, summaryStyle: 'compact', repairInvalidJson: false, classifyWithModel: false },
    );
  }
  if (settings.aiProvider === 'chrome') {
    return createPromptBackedProvider(
      'chrome',
      (system, user, options) => deps.completeOnDevice('gemini-nano', system, user, options),
      { maxUserChars: 7_000, summaryStyle: 'compact' },
    );
  }
  if (!settings.aiApiKey && settings.aiProvider !== 'ollama') return null;
  return createAIProvider(settings.aiProvider, {
    apiKey: settings.aiApiKey,
    model: settings.aiModel,
    endpoint: settings.aiEndpoint,
  });
}

function cloudProvider(client: PigeonBoxCloudClient | null): AIProvider {
  if (!client) return failingProvider(new CloudApiError({ code: 'not_configured', message: 'PigeonBox Cloud is not available in this build.' }));
  return withFriendlyErrors(createCloudAIProvider(client));
}

/** Rethrow Cloud failures with wording a user can act on. The original stays as `cause`. */
function withFriendlyErrors(provider: AIProvider): AIProvider {
  const wrap = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await fn(...args);
      } catch (error) {
        const friendly = new Error(cloudErrorMessage(error).message, { cause: error });
        (friendly as Error & { retryable?: boolean }).retryable = error instanceof CloudApiError && error.code === 'rate_limited';
        throw friendly;
      }
    };
  return {
    name: provider.name,
    classifyEmail: wrap(provider.classifyEmail.bind(provider)),
    summarizeThread: wrap(provider.summarizeThread.bind(provider)),
    draftReply: wrap(provider.draftReply.bind(provider)),
    draftFollowUp: wrap(provider.draftFollowUp.bind(provider)),
    rewriteText: wrap(provider.rewriteText.bind(provider)),
    answerMailboxQuery: wrap(provider.answerMailboxQuery.bind(provider)),
    embed: wrap(provider.embed.bind(provider)),
  };
}

function failingProvider(error: CloudApiError): AIProvider {
  const fail = async (): Promise<never> => {
    throw new Error(cloudErrorMessage(error).message, { cause: error });
  };
  return {
    name: 'pigeonbox-cloud',
    classifyEmail: fail,
    summarizeThread: fail,
    draftReply: fail,
    draftFollowUp: fail,
    rewriteText: fail,
    answerMailboxQuery: fail,
    embed: fail,
  };
}

/**
 * Settings as the agent and the Gmail UI should see them. In Cloud mode, AI is
 * on and served by PigeonBox Cloud, whatever the saved Local AI choice is; the
 * saved Local choice is kept untouched for when the user switches back. The BYOK
 * key is blanked so no Cloud-mode code path can reach it.
 */
export function effectiveSettings(settings: ExtensionSettings): ExtensionSettings {
  if (settings.runMode !== 'cloud') return settings;
  return {
    ...settings,
    aiMode: 'remote',
    aiProvider: 'openai-compatible',
    aiModel: 'PigeonBox Cloud',
    aiEndpoint: '',
    aiApiKey: '',
  };
}

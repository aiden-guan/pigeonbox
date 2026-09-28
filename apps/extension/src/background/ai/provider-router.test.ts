import { describe, expect, it, vi } from 'vitest';
import { PigeonBoxCloudClient } from '@pigeonbox/cloud-client';
import { DEFAULT_SETTINGS, type ExtensionSettings } from '@pigeonbox/shared';
import { effectiveSettings, resolveAIProvider, type AIProviderRouterDeps } from './provider-router';

const summaryInput = { subject: 'Hi', messages: [{ sender: 'dana@example.com', bodyText: 'Lunch Friday?', timestamp: '' }] };

function deps(overrides: Partial<AIProviderRouterDeps> = {}): AIProviderRouterDeps {
  return {
    completeChatGpt: vi.fn(async () => ({ text: '{}' })),
    completeOnDevice: vi.fn(async () => ({ text: 'Summary: Dana asks about lunch Friday.' })),
    cloudClient: () => null,
    experimental: true,
    ...overrides,
  };
}

const cloudSettings: ExtensionSettings = {
  ...DEFAULT_SETTINGS,
  runMode: 'cloud',
  cloudConsentAt: '2026-09-01T00:00:00Z',
  // A BYOK key saved from Local mode must never be used in Cloud mode.
  aiMode: 'remote',
  aiProvider: 'openai',
  aiApiKey: 'sk-local-key',
};

describe('resolveAIProvider', () => {
  it('Local with AI off has no provider and never touches Cloud', () => {
    const cloudClient = vi.fn(() => null);
    expect(resolveAIProvider(DEFAULT_SETTINGS, deps({ cloudClient }))).toBeNull();
    expect(cloudClient).not.toHaveBeenCalled();
  });

  it('Local on-device model stays on the device', async () => {
    const d = deps();
    const ai = resolveAIProvider({ ...DEFAULT_SETTINGS, aiMode: 'local', aiProvider: 'local', aiModel: 'lfm2-700m' }, d)!;
    expect(ai.name).toBe('local');
    await ai.summarizeThread(summaryInput).catch(() => undefined);
    expect(d.completeOnDevice).toHaveBeenCalled();
  });

  it('Local BYOK uses the configured provider', () => {
    const ai = resolveAIProvider({ ...DEFAULT_SETTINGS, aiMode: 'remote', aiProvider: 'openai', aiApiKey: 'sk-x' }, deps());
    expect(ai?.name).toBe('openai');
  });

  it('release builds ignore the experimental ChatGPT provider', () => {
    const settings = { ...DEFAULT_SETTINGS, aiMode: 'remote' as const, aiProvider: 'chatgpt' as const };
    expect(resolveAIProvider(settings, deps({ experimental: false }))).toBeNull();
    expect(resolveAIProvider(settings, deps({ experimental: true }))?.name).toBe('chatgpt');
  });

  it('Cloud mode uses PigeonBox Cloud, not the saved BYOK provider', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ result: { oneLine: 'Lunch Friday', keyPoints: [], decisions: [], unansweredQuestions: [], commitments: [], dates: [], actionItems: [] } }), { status: 200 }),
    );
    const client = new PigeonBoxCloudClient({ baseUrl: 'https://api.example.com', fetch: fetchMock as unknown as typeof fetch, tokens: { get: async () => 't', refresh: async () => null } });
    const d = deps({ cloudClient: () => client });
    const ai = resolveAIProvider(cloudSettings, d)!;
    expect(ai.name).toBe('pigeonbox-cloud');
    const { result } = await ai.summarizeThread(summaryInput);
    expect(result.oneLine).toBe('Lunch Friday');
    expect(String((fetchMock.mock.calls as unknown[][])[0]![0])).toBe('https://api.example.com/v1/ai/summarize');
    expect(d.completeOnDevice).not.toHaveBeenCalled();
  });

  it('Cloud outage fails clearly and never falls back to another provider', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const client = new PigeonBoxCloudClient({ baseUrl: 'https://api.example.com', fetch: fetchMock as unknown as typeof fetch, tokens: { get: async () => 't', refresh: async () => null } });
    const d = deps({ cloudClient: () => client });
    const ai = resolveAIProvider(cloudSettings, d)!;
    await expect(ai.summarizeThread(summaryInput)).rejects.toThrow('PigeonBox Cloud is unavailable. Nothing was sent to another provider.');
    expect(d.completeOnDevice).not.toHaveBeenCalled();
    expect(d.completeChatGpt).not.toHaveBeenCalled();
    // Only the Cloud endpoint was contacted.
    for (const call of fetchMock.mock.calls as unknown[][]) expect(String(call[0])).toContain('api.example.com');
  });

  it('Cloud mode in a build without Cloud reports it instead of using Local providers', async () => {
    const d = deps({ cloudClient: () => null });
    const ai = resolveAIProvider(cloudSettings, d)!;
    await expect(ai.draftReply({ subject: 's', messages: summaryInput.messages, voice: DEFAULT_SETTINGS.voiceProfile, kind: 'reply' })).rejects.toThrow(
      /not available in this build/,
    );
  });

  it('expired subscription surfaces as a subscription message', async () => {
    const client = new PigeonBoxCloudClient({
      baseUrl: 'https://api.example.com',
      fetch: (async () => new Response(JSON.stringify({ error: { code: 'entitlement_required', message: 'x', retryable: false } }), { status: 402 })) as unknown as typeof fetch,
      tokens: { get: async () => 't', refresh: async () => null },
    });
    const ai = resolveAIProvider(cloudSettings, deps({ cloudClient: () => client }))!;
    await expect(ai.rewriteText({ text: 'hello', mode: 'improve' })).rejects.toThrow(/subscription is not active/);
  });
});

describe('effectiveSettings', () => {
  it('leaves Local settings untouched', () => {
    const local = { ...DEFAULT_SETTINGS, aiMode: 'local' as const, aiProvider: 'local' as const };
    expect(effectiveSettings(local)).toBe(local);
  });

  it('turns AI on for Cloud and hides the BYOK key without changing saved settings', () => {
    const view = effectiveSettings(cloudSettings);
    expect(view.aiMode).toBe('remote');
    expect(view.aiApiKey).toBe('');
    expect(cloudSettings.aiApiKey).toBe('sk-local-key');
  });
});

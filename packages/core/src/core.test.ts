import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@pigeonbox/shared';
import { SIGNED_OUT_CLOUD, aiDataDestination, localCapabilities, resolveCapabilities, type CloudState } from './index';

const ready: CloudState = { status: 'ready', email: 'a@example.com', plan: 'cloud', capabilities: ['cloud_ai', 'cloud_tracking', 'unknown_future'] };

describe('capabilities', () => {
  it('Local with AI off still has Ask Pigeon and no account capabilities', () => {
    const caps = resolveCapabilities({ mode: 'local', settings: DEFAULT_SETTINGS, cloud: SIGNED_OUT_CLOUD });
    expect(caps.list()).toEqual(['ask_inbox']);
    expect(caps.has('cloud_ai')).toBe(false);
  });

  it('Local with a model has local_ai', () => {
    expect(localCapabilities({ aiMode: 'local', aiProvider: 'local' })).toContain('local_ai');
    expect(localCapabilities({ aiMode: 'remote', aiProvider: 'ollama' })).toContain('local_ai');
  });

  it('Local ignores Cloud state entirely, even when Cloud is ready', () => {
    const caps = resolveCapabilities({ mode: 'local', settings: { aiMode: 'local', aiProvider: 'local' }, cloud: ready });
    expect(caps.list()).toEqual(['local_ai', 'ask_inbox']);
  });

  it('Cloud uses what the server granted and drops unknown names', () => {
    const caps = resolveCapabilities({ mode: 'cloud', settings: DEFAULT_SETTINGS, cloud: ready });
    expect(caps.list()).toEqual(['cloud_ai', 'ask_inbox', 'cloud_tracking']);
  });

  it('Cloud outage or expiry removes Cloud capabilities without granting remote fallbacks', () => {
    for (const status of ['unreachable', 'expired', 'signed_out'] as const) {
      const caps = resolveCapabilities({ mode: 'cloud', settings: { aiMode: 'remote', aiProvider: 'openai' }, cloud: { ...ready, status } });
      expect(caps.has('cloud_ai')).toBe(false);
      expect(caps.has('local_ai')).toBe(false);
      expect(caps.has('ask_inbox')).toBe(true);
    }
  });

  it('a server cannot grant local_ai', () => {
    const caps = resolveCapabilities({ mode: 'cloud', settings: DEFAULT_SETTINGS, cloud: { ...ready, capabilities: ['local_ai'] } });
    expect(caps.has('local_ai')).toBe(false);
  });
});

describe('aiDataDestination', () => {
  it('describes where mail goes', () => {
    expect(aiDataDestination({ ...DEFAULT_SETTINGS })).toBe('none');
    expect(aiDataDestination({ ...DEFAULT_SETTINGS, aiMode: 'local', aiProvider: 'local' })).toBe('this_device');
    expect(aiDataDestination({ ...DEFAULT_SETTINGS, aiMode: 'local', aiProvider: 'ollama', aiEndpoint: 'http://127.0.0.1:11434/v1' })).toBe('this_device');
    expect(aiDataDestination({ ...DEFAULT_SETTINGS, aiMode: 'remote', aiProvider: 'ollama', aiEndpoint: 'https://gpu.example.com/v1' })).toBe('your_provider');
    expect(aiDataDestination({ ...DEFAULT_SETTINGS, aiMode: 'remote', aiProvider: 'openai' })).toBe('your_provider');
    expect(aiDataDestination({ ...DEFAULT_SETTINGS, runMode: 'cloud' })).toBe('pigeonbox_cloud');
  });
});

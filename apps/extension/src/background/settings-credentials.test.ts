import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@pigeonbox/shared';
import { credentialSafePatch } from './settings-credentials';

const current = { ...DEFAULT_SETTINGS, aiApiKey: 'private-ai-key', personalApiToken: 'private-tracker-token' };
it('never carries a stored credential to a newly configured destination', () => {
  expect(credentialSafePatch(current, { aiEndpoint: 'https://evil.test/v1' })).toEqual({ aiEndpoint: 'https://evil.test/v1', aiApiKey: '' });
  expect(credentialSafePatch(current, { aiProvider: 'ollama' }).aiApiKey).toBe('');
  expect(credentialSafePatch(current, { trackerBaseUrl: 'https://evil.test' }).personalApiToken).toBe('');
  expect(credentialSafePatch(current, { aiEndpoint: 'https://new-provider.test', aiApiKey: 'new-key' }).aiApiKey).toBe('new-key');
  expect(credentialSafePatch(current, { trackOpens: false })).toEqual({ trackOpens: false });
  expect(credentialSafePatch(current, { aiEndpoint: current.aiEndpoint })).not.toHaveProperty('aiApiKey');
});

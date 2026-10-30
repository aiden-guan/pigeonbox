import { describe, expect, it } from 'vitest';
import { createIntelHarness } from '../testing/intel-harness.js';

describe('extension settings saved to the account', () => {
  it('stores a snapshot, merges later changes, and keeps each account to itself', async () => {
    const h = await createIntelHarness();
    const ada = await h.signIn('ada@free.test');
    const bob = await h.signIn('bob@free.test');

    expect(await h.route('controlExtensionSettings', ada.accessToken)).toEqual({ backup: null });

    await h.route('controlExtensionSettingsSave', ada.accessToken, { settings: { trackingEnabled: false, aiProvider: 'openai', neverArchiveSenders: ['boss@work.test'], voiceProfile: { name: 'Ada', emoji: false } }, rules: ['Archive receipts'], replace: true });
    await h.route('controlExtensionSettingsSave', ada.accessToken, { settings: { aiProvider: 'anthropic' } });
    const { backup } = await h.route<{ backup: { settings: Record<string, unknown>; rules: string[] } }>('controlExtensionSettings', ada.accessToken);
    expect(backup.settings).toEqual({ trackingEnabled: false, aiProvider: 'anthropic', neverArchiveSenders: ['boss@work.test'], voiceProfile: { name: 'Ada', emoji: false } });
    expect(backup.rules).toEqual(['Archive receipts']);

    // A new snapshot drops settings that are no longer in it.
    await h.route('controlExtensionSettingsSave', ada.accessToken, { settings: { autoArchive: true }, replace: true });
    expect((await h.route<{ backup: { settings: unknown } }>('controlExtensionSettings', ada.accessToken)).backup.settings).toEqual({ autoArchive: true });

    expect(await h.route('controlExtensionSettings', bob.accessToken)).toEqual({ backup: null });
  });

  it('refuses secrets', async () => {
    const h = await createIntelHarness();
    const ada = await h.signIn('ada@free.test');
    const response = await h.call('/v1/control/extension-settings/save', { token: ada.accessToken, body: { settings: { aiApiKey: 'sk-live-secret' } } });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await h.sql('select * from public.extension_settings_backups'))).not.toContain('sk-live-secret');
  });
});

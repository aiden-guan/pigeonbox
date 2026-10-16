import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_VERSION, migrateSettings, toPublicSettings } from './index';

/** A settings object exactly as version 0.1.x stored it (no settingsVersion, no run mode). */
const legacy = {
  trackingEnabled: true,
  trackOpens: true,
  trackLinks: false,
  desktopNotifications: false,
  hideSuspectedSelfOpens: true,
  trackerBaseUrl: 'https://tracker.example.convex.site',
  personalApiToken: 'tok_secret',
  aiMode: 'local',
  aiProvider: 'local',
  aiModel: 'lfm2-700m',
  aiEndpoint: 'https://api.openai.com/v1',
  aiApiKey: 'sk-live-secret',
  autoClassify: true,
  autoSummarize: true,
  autoDraft: true,
  autoInsertDraft: false,
  autoReminders: true,
  autoArchive: false,
  archiveCategories: ['PROMOTIONS'],
  archiveConfidenceThreshold: 0.9,
  alwaysArchiveSenders: ['news@example.com'],
  neverArchiveSenders: [],
  reminderMode: 'ai_needed',
  reminderBusinessDays: 2,
  commandPaletteEnabled: true,
  commandPaletteOverrideGmail: false,
  inboxSdkAppId: 'sdk_Intelligence_c698f940a0',
  voiceProfile: { name: 'Ada', greeting: 'Hey' },
  learnFromSent: false,
};

describe('migrateSettings', () => {
  it('keeps every field a 0.1.x install saved and adds Local run mode', () => {
    const migrated = migrateSettings(legacy);
    for (const [key, value] of Object.entries(legacy)) {
      if (key === 'voiceProfile') continue;
      expect(migrated[key as keyof typeof migrated]).toEqual(value);
    }
    expect(migrated.voiceProfile).toEqual({ ...DEFAULT_SETTINGS.voiceProfile, name: 'Ada', greeting: 'Hey' });
    expect(migrated.runMode).toBe('local');
    expect(migrated.cloudConsentAt).toBeNull();
    expect(migrated.settingsVersion).toBe(SETTINGS_VERSION);
  });

  it('never turns an old install into Cloud mode', () => {
    expect(migrateSettings({ ...legacy, runMode: 'cloud', cloudConsentAt: '2026-01-01T00:00:00Z' }).runMode).toBe('local');
  });

  it('keeps Cloud mode for a current install that consented', () => {
    const current = { ...DEFAULT_SETTINGS, runMode: 'cloud' as const, cloudConsentAt: '2026-09-01T00:00:00Z' };
    expect(migrateSettings(current).runMode).toBe('cloud');
  });

  it('refuses Cloud mode without recorded consent', () => {
    expect(migrateSettings({ ...DEFAULT_SETTINGS, runMode: 'cloud', cloudConsentAt: null }).runMode).toBe('local');
  });

  it('handles empty and malformed storage', () => {
    expect(migrateSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(migrateSettings('garbage')).toEqual(DEFAULT_SETTINGS);
    const repaired = migrateSettings({ ...DEFAULT_SETTINGS, aiMode: 'weird', aiProvider: 'nope', runMode: 'moon' });
    expect(repaired.aiMode).toBe('disabled');
    expect(repaired.aiProvider).toBe(DEFAULT_SETTINGS.aiProvider);
    expect(repaired.runMode).toBe('local');
  });

  it('is idempotent', () => {
    const once = migrateSettings(legacy);
    expect(migrateSettings(once)).toEqual(once);
  });

  it('public settings never carry secrets', () => {
    const view = toPublicSettings(migrateSettings(legacy)) as Record<string, unknown>;
    expect(view.aiApiKey).toBeUndefined();
    expect(view.personalApiToken).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('secret');
    expect(view.hasAiApiKey).toBe(true);
  });

  it('keeps installs with a self-hosted tracker on it by making them local-only', () => {
    expect(migrateSettings({ ...legacy, settingsVersion: 3 }).localOnly).toBe(true);
    expect(migrateSettings({ ...legacy, settingsVersion: 3, trackerBaseUrl: '', personalApiToken: '' }).localOnly).toBe(false);
    expect(migrateSettings({}).localOnly).toBe(false);
  });

  it('keeps a local-only choice made after version 4', () => {
    expect(migrateSettings({ ...DEFAULT_SETTINGS, localOnly: true }).localOnly).toBe(true);
    expect(migrateSettings({ ...DEFAULT_SETTINGS, trackerBaseUrl: 'https://t.example', personalApiToken: 'x', localOnly: false }).localOnly).toBe(false);
  });
});

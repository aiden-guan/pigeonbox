import type { ExtensionSettings } from '@pigeonbox/shared';

/** A destination change must not silently carry an existing credential to it. */
export function credentialSafePatch(current: ExtensionSettings, patch: Partial<ExtensionSettings>): Partial<ExtensionSettings> {
  const next = { ...patch };
  const changed = (key: 'aiEndpoint' | 'aiProvider' | 'trackerBaseUrl') => patch[key] !== undefined && patch[key] !== current[key];
  if ((changed('aiEndpoint') || changed('aiProvider')) && patch.aiApiKey === undefined) next.aiApiKey = '';
  if (changed('trackerBaseUrl') && patch.personalApiToken === undefined) next.personalApiToken = '';
  return next;
}

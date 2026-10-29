import {
  KNOWN_CAPABILITIES,
  knownCapabilities,
  type PigeonBoxCapability,
  type PigeonBoxMode,
} from '@pigeonbox/api-contract';
import type { AiProcessingMode, ExtensionSettings } from '@pigeonbox/shared';

export type { PigeonBoxCapability, PigeonBoxMode };
export { KNOWN_CAPABILITIES };

/**
 * State of the PigeonBox server connection as the background worker sees it.
 * - not_configured: no server URL (typical for release and source builds without one)
 * - signed_out:     no session
 * - ready:          signed in and capabilities fetched
 * - not_entitled:   signed in, but the server grants this account no server AI
 * - expired:        the session could not be refreshed
 * - unreachable:    the last request failed at the network level
 */
/** `update_required`: this extension version is too old for the PigeonBox server (never reported as an outage). */
export type CloudConnectionStatus = 'not_configured' | 'signed_out' | 'ready' | 'not_entitled' | 'expired' | 'unreachable' | 'update_required';

/** Set when the server asks for a newer extension; `required` blocks server mode, otherwise it is a recommendation. */
export type CloudUpdateNotice = { required: boolean; installed: string; minimum: string | null; recommended: string | null };

export type CloudState = {
  status: CloudConnectionStatus;
  email: string | null;
  /** Capabilities from `/v1/capabilities`; empty until fetched. */
  capabilities: readonly string[];
  update?: CloudUpdateNotice;
  /** Planned maintenance or degraded service, from remote client config. The extension owns the wording. */
  notice?: 'maintenance' | 'degraded';
};

export const SIGNED_OUT_CLOUD: CloudState = { status: 'signed_out', email: null, capabilities: [] };

export type LocalCapabilityInput = Pick<ExtensionSettings, 'aiMode' | 'aiProvider'>;

/** Local capabilities come from the device and settings only. No network, no account. */
export function localCapabilities(settings: LocalCapabilityInput): PigeonBoxCapability[] {
  // Ask Pigeon always works: with AI off it returns lexical matches from the local index.
  const caps: PigeonBoxCapability[] = ['ask_inbox'];
  if (isLocalAiConfigured(settings.aiMode)) caps.push('local_ai');
  return caps;
}

function isLocalAiConfigured(aiMode: AiProcessingMode): boolean {
  return aiMode !== 'disabled';
}

export class CapabilitySet {
  private readonly set: ReadonlySet<PigeonBoxCapability>;

  constructor(capabilities: Iterable<PigeonBoxCapability>) {
    this.set = new Set(capabilities);
  }

  has(capability: PigeonBoxCapability): boolean {
    return this.set.has(capability);
  }

  list(): PigeonBoxCapability[] {
    return KNOWN_CAPABILITIES.filter((capability) => this.set.has(capability));
  }
}

/**
 * The capabilities PigeonBox has right now.
 *
 * Local mode never looks at server state, so a server outage, an account the
 * server no longer allows or a signed-out session cannot change what Local does.
 * Server mode uses what the server granted, plus the parts of the product that
 * always run on the device (the local index behind Ask Pigeon).
 */
export function resolveCapabilities(input: {
  mode: PigeonBoxMode;
  settings: LocalCapabilityInput;
  cloud: CloudState;
}): CapabilitySet {
  if (input.mode === 'local') return new CapabilitySet(localCapabilities(input.settings));
  const granted =
    input.cloud.status === 'ready' || input.cloud.status === 'not_entitled' ? knownCapabilities(input.cloud.capabilities) : [];
  // `local_ai` is a Local-mode capability; the server cannot grant it.
  return new CapabilitySet([...granted.filter((capability) => capability !== 'local_ai'), 'ask_inbox']);
}

export function hasCapability(set: CapabilitySet, capability: PigeonBoxCapability): boolean {
  return set.has(capability);
}

/**
 * Where email content goes for AI in the current configuration. Used for the
 * privacy line in Settings and in diagnostics.
 */
export type DataDestination = 'none' | 'this_device' | 'your_provider' | 'pigeonbox_cloud' | 'chatgpt_web';

export function aiDataDestination(settings: Pick<ExtensionSettings, 'runMode' | 'aiMode' | 'aiProvider' | 'aiEndpoint'>): DataDestination {
  if (settings.runMode === 'cloud') return 'pigeonbox_cloud';
  if (settings.aiMode === 'disabled') return 'none';
  if (settings.aiProvider === 'local' || settings.aiProvider === 'chrome') return 'this_device';
  if (settings.aiProvider === 'chatgpt') return 'chatgpt_web';
  if (settings.aiProvider === 'ollama' && isLoopbackUrl(settings.aiEndpoint)) return 'this_device';
  return 'your_provider';
}

function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value || 'http://127.0.0.1:11434').hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  } catch {
    return false;
  }
}

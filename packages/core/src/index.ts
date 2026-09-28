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
 * State of the Cloud connection as the background worker sees it.
 * - not_configured: this build has no Cloud API URL (typical for source builds)
 * - signed_out:     no session
 * - ready:          signed in and capabilities fetched
 * - not_entitled:   signed in, but the server grants no Cloud AI
 * - expired:        the session could not be refreshed
 * - unreachable:    the last request failed at the network level
 */
export type CloudConnectionStatus = 'not_configured' | 'signed_out' | 'ready' | 'not_entitled' | 'expired' | 'unreachable';

export type CloudState = {
  status: CloudConnectionStatus;
  email: string | null;
  plan: string | null;
  /** Capabilities from `/v1/capabilities`; empty until fetched. */
  capabilities: readonly string[];
};

export const SIGNED_OUT_CLOUD: CloudState = { status: 'signed_out', email: null, plan: null, capabilities: [] };

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
 * Local mode never looks at Cloud state, so a Cloud outage, an expired
 * subscription or a signed-out account cannot change what Local does.
 * Cloud mode uses what the server granted, plus the parts of the product that
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

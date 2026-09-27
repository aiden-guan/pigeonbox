import { z } from 'zod';

/** How PigeonBox runs. Local needs no account; Cloud uses a PigeonBox account. */
export const PigeonBoxModeSchema = z.enum(['local', 'cloud']);
export type PigeonBoxMode = z.infer<typeof PigeonBoxModeSchema>;

/**
 * Product capabilities. Local capabilities are computed on the device; Cloud
 * capabilities come from the server's entitlement check. UI code asks
 * `hasCapability(...)` rather than checking a mode or a plan name.
 *
 * A Cloud capability means PigeonBox Cloud can serve the feature for this
 * account right now: the plan includes it and the server has the
 * infrastructure for it configured. It does not mean the user connected
 * anything yet: `cloud_mail_sync` is granted before a Google account is
 * connected, so the UI can offer the connection.
 *
 * Only list a capability here once something implements it. The server never
 * returns capabilities it cannot serve. Names reserved in protocol 1.0 that no
 * server ever granted (`cloud_search`, `cloud_sync`, `calendar`, …) were
 * replaced by the concrete names below; older extensions drop unknown names.
 */
export const KNOWN_CAPABILITIES = [
  /** AI runs on this device or with the user's own provider. Local only. */
  'local_ai',
  /** Hosted inference for the extension's AI operations. */
  'cloud_ai',
  /** Ask questions about mail. Always available; Local answers from the on-device index. */
  'ask_inbox',
  /** Hosted open and click tracking (tracker protocol v3). */
  'cloud_tracking',
  /** Always-on Gmail synchronization through a Cloud-only Google connection. */
  'cloud_mail_sync',
  /** Drafts prepared in the background before the user opens a thread. */
  'cloud_auto_drafts',
  /** Smart Views with Shadow Mode, natural-language automations, approvals and briefings. */
  'cloud_automations',
  /** Google Calendar availability, scheduling replies and meeting briefs. */
  'cloud_calendar',
  /** Ask Pigeon: hybrid retrieval over synced mail, calendar, contacts and notes, with sources. */
  'cloud_semantic_search',
  /** Contacts, relationship briefs and the Relationship Radar. */
  'cloud_relationships',
  /** Tracked PDF documents with per-recipient links. */
  'cloud_documents',
  /** Workspaces, assignments, internal comments and shared snippets. */
  'cloud_team',
  /** MCP server and developer API tokens. */
  'cloud_mcp',
  /** Controlled, personalized sequences with stop-on-reply and suppression. */
  'cloud_sequences',
] as const;

export const PigeonBoxCapabilitySchema = z.enum(KNOWN_CAPABILITIES);
export type PigeonBoxCapability = z.infer<typeof PigeonBoxCapabilitySchema>;

/**
 * Capabilities that exist only because PigeonBox Cloud keeps a server-side
 * connection to the user's accounts. Local mode cannot provide these without a
 * continuously running server, which is what Cloud is for.
 */
export const ALWAYS_ON_CAPABILITIES: readonly PigeonBoxCapability[] = [
  'cloud_mail_sync',
  'cloud_auto_drafts',
  'cloud_automations',
  'cloud_calendar',
  'cloud_semantic_search',
  'cloud_relationships',
];

/**
 * Parse a capability list from the server. Unknown names are dropped rather than
 * rejected so a newer server never breaks an older extension.
 */
export function knownCapabilities(values: readonly string[]): PigeonBoxCapability[] {
  const known = new Set<string>(KNOWN_CAPABILITIES);
  return [...new Set(values.filter((value): value is PigeonBoxCapability => known.has(value)))];
}

/** Lenient on the wire, typed after `knownCapabilities`. */
export const CapabilityListSchema = z.array(z.string().max(64)).max(64);

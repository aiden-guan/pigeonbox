import { z } from 'zod';

/** Inbox intelligence categories — product definitions. */
export const ThreadCategorySchema = z.enum([
  'RESPOND',
  'WAITING',
  'FYI',
  'NOTIFICATIONS',
  'PROMOTIONS',
  'NEWS',
]);
export type ThreadCategory = z.infer<typeof ThreadCategorySchema>;

export const PrioritySchema = z.enum(['HIGH', 'NORMAL', 'LOW']);
export type Priority = z.infer<typeof PrioritySchema>;

export const AgentSafetyTier = {
  READ_ONLY: 0,
  REVERSIBLE: 1,
  DRAFT_WRITE: 2,
  DESTRUCTIVE: 3,
} as const;
export type AgentSafetyTierLevel = (typeof AgentSafetyTier)[keyof typeof AgentSafetyTier];

export const ClassificationResultSchema = z.object({
  category: ThreadCategorySchema,
  confidence: z.number().min(0).max(1),
  priority: PrioritySchema,
  needsReply: z.boolean(),
  waitingOnReply: z.boolean(),
  archiveRecommendation: z.boolean(),
  reason: z.string().max(500),
  deadline: z.string().nullable().optional(),
});
export type ClassificationResult = z.infer<typeof ClassificationResultSchema>;

export const NeedsReplyResultSchema = z.object({
  needsReply: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(500),
});
export type NeedsReplyResult = z.infer<typeof NeedsReplyResultSchema>;

export const ThreadSummarySchema = z.object({
  reasoning: z.string().optional(),
  oneLine: z.string().max(400),
  keyPoints: z.array(z.string()).max(12),
  decisions: z.array(z.string()).max(8),
  unansweredQuestions: z.array(z.string()).max(8),
  commitments: z.array(z.string()).max(8),
  dates: z.array(z.string()).max(8),
  actionItems: z.array(z.string()).max(12),
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

export const DraftSuggestionSchema = z.object({
  mode: z.enum(['direct', 'warm', 'short']).default('direct'),
  subject: z.string().optional(),
  body: z.string().min(1),
  placeholders: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).optional(),
});
export type DraftSuggestion = {
  mode: 'direct' | 'warm' | 'short';
  subject?: string;
  body: string;
  placeholders: string[];
  confidence?: number;
};

export const ContactSchema = z.object({
  email: z.string().email().or(z.string().min(1)),
  name: z.string().optional(),
});
export type Contact = z.infer<typeof ContactSchema>;

export const AttachmentMetaSchema = z.object({
  filename: z.string(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().optional(),
});
export type AttachmentMeta = z.infer<typeof AttachmentMetaSchema>;

export type GmailActionResult = {
  success: boolean;
  capability: string;
  action?: string;
  threadId?: string;
  verified?: boolean;
  error?: string;
  reason?: string;
  retryable?: boolean;
};

/** How complete a locally stored Gmail thread is. Never invent missing fields. */
export type ThreadDataQuality = 'ROW_STUB' | 'THREAD_PARTIAL' | 'THREAD_COMPLETE';

export type ThreadDataSource = 'inboxsdk' | 'dom' | 'hydrated' | 'compose';

export type GmailCapabilities = {
  inboxSdkAvailable: boolean;
  gmailJsCaptureAvailable: boolean;
  backgroundWorkerTabAvailable: boolean;
  persistentNativeLabelMutationAvailable: boolean;
  domFallbackAvailable: boolean;
};

export {
  PLACEHOLDER_PATTERN,
  detectPlaceholders,
  findPlaceholders,
  hasUnresolvedPlaceholders,
  placeholderToken,
} from './placeholders.js';
export type { Placeholder, PlaceholderKind } from './placeholders.js';

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sanitize email HTML for safe display in extension React UI (never raw). */
export function sanitizeEmailHtml(html: string): string {
  const withoutDangerous = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?>/gi, '')
    .replace(/on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/data:text\/html/gi, '');
  // Prefer plaintext for React UI; return escaped fragment if needed
  return stripHtml(withoutDangerous);
}

import { hashBody, sha256Hex } from './crypto.js';
export { hashBody, sha256Hex };

export async function contentFingerprint(parts: {
  gmailThreadId: string;
  latestMessageId: string;
  latestTimestamp: string;
  normalizedBodyHash: string;
}): Promise<string> {
  return sha256Hex(
    `${parts.gmailThreadId}|${parts.latestMessageId}|${parts.latestTimestamp}|${parts.normalizedBodyHash}`,
  );
}

/**
 * Identity for mail that already exists in Gmail.
 * ROW_STUB never includes a clock reading. THREAD_COMPLETE uses message ids and body text.
 */
export async function stableThreadFingerprint(input: {
  quality: ThreadDataQuality;
  threadId: string;
  subject: string;
  sender: string;
  snippet: string;
  messageCount?: number;
  stableId?: string;
  messages?: Array<{ messageId: string; bodyText: string }>;
}): Promise<string> {
  if (input.quality === 'THREAD_COMPLETE' && input.messages && input.messages.length > 0) {
    const ids = [...input.messages].map((message) => message.messageId).sort().join(',');
    const bodyHash = await hashBody(input.messages.map((message) => message.bodyText).join('\n'));
    return sha256Hex(`${input.threadId}|complete|${ids}|${bodyHash}`);
  }
  const snippetHash = await hashBody(input.snippet || '');
  return sha256Hex(
    [
      input.threadId,
      input.subject.trim(),
      input.sender.trim().toLowerCase(),
      snippetHash,
      String(input.messageCount ?? ''),
      input.stableId || '',
      input.quality,
    ].join('|'),
  );
}

export const BridgeMessageSchema = z.object({
  source: z.literal('gi-main-world'),
  type: z.string().min(1).max(64),
  payload: z.unknown().optional(),
  requestId: z.string().optional(),
  ts: z.number().optional(),
});
export type BridgeMessage = z.infer<typeof BridgeMessageSchema>;

export const RuntimeMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PING') }),
  z.object({ type: z.literal('GET_SETTINGS') }),
  z.object({ type: z.literal('GET_PUBLIC_SETTINGS') }),
  z.object({
    type: z.literal('SAVE_SETTINGS'),
    settings: z.record(z.unknown()),
  }),
  z.object({ type: z.literal('RUN_DIAGNOSTICS') }),
  z.object({
    type: z.literal('GMAIL_EVENT'),
    event: z.string(),
    payload: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('ENQUEUE_ACTION'),
    action: z.string(),
    args: z.record(z.unknown()).optional(),
  }),
  // Ask Pigeon. The message name predates the feature name.
  z.object({
    type: z.literal('ASK_INBOX'),
    query: z.string().min(1).max(2000),
  }),
  z.object({
    type: z.literal('OPEN_COMPOSE_DRAFT'),
    draft: z.object({
      to: z.array(z.object({ email: z.string().max(320), name: z.string().max(200).optional() })).max(20),
      subject: z.string().max(500),
      body: z.string().max(20_000),
    }),
  }),
  z.object({
    type: z.literal('INDEX_INBOX'),
    mode: z.enum(['7d', '30d', '90d', '1y', 'custom', 'sent_sample']),
    customQuery: z.string().optional(),
  }),
  z.object({ type: z.literal('PAUSE_INDEX') }),
  z.object({ type: z.literal('RESUME_INDEX') }),
  z.object({ type: z.literal('CLEAR_INDEX') }),
  z.object({ type: z.literal('CLEAR_AI_CACHE') }),
  z.object({ type: z.literal('GET_ACTIVITY_LOG') }),
  z.object({
    type: z.literal('UNDO_ACTION'),
    actionId: z.string(),
  }),
  z.object({
    type: z.literal('TRACKING_POLL'),
  }),
  z.object({
    type: z.literal('TRACKING_SELF_VIEW'),
    trackingId: z.string(),
    timestamp: z.string().optional(),
    gmailThreadId: z.string().nullable().optional(),
    gmailMessageId: z.string().nullable().optional(),
    source: z
      .enum([
        'ROW_INTERACTION',
        'MESSAGE_EXPANDED',
        'MESSAGE_LOAD',
        'CACHE_REINSPECTION',
        'PAGE_RELOAD',
      ])
      .optional(),
    selfViewEventId: z.string().optional(),
    reconcileGmailIds: z.boolean().optional(),
    quotedRender: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('REQUEST_SUMMARY'),
    threadId: z.string(),
    subject: z.string().optional(),
    messages: z.array(z.record(z.unknown())).optional(),
    force: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('REQUEST_DRAFT'),
    threadId: z.string(),
    subject: z.string().optional(),
    messages: z.array(z.record(z.unknown())).optional(),
    force: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('GET_AI_JOB_STATUS'),
    jobId: z.string(),
  }),
  z.object({
    type: z.literal('WRITE_WITH_AI'),
    mode: z.string(),
    text: z.string(),
    context: z.string().optional(),
  }),
  z.object({ type: z.literal('CHATGPT_LOGIN') }),
  z.object({ type: z.literal('CHATGPT_LOGOUT') }),
  z.object({ type: z.literal('CHATGPT_STATUS') }),
  z.object({
    type: z.literal('LOCAL_MODEL_DOWNLOAD'),
    modelId: z.string().min(1).max(64),
  }),
]);
export type RuntimeMessage = z.infer<typeof RuntimeMessageSchema>;

export function getProviderRequiredOrigin(provider: string, endpoint?: string): string | null {
  if (provider === 'openai') {
    return 'https://api.openai.com/*';
  }
  if (provider === 'ollama') {
    if (!endpoint) return 'http://127.0.0.1:11434/*';
    try {
      const u = new URL(endpoint);
      return `${u.protocol}//${u.host}/*`;
    } catch {
      return 'http://127.0.0.1:11434/*';
    }
  }
  if (provider === 'openai-compatible') {
    if (!endpoint) return null;
    try {
      const u = new URL(endpoint);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return `${u.protocol}//${u.host}/*`;
    } catch {
      return null;
    }
  }
  return null;
}

export type AiProcessingMode = 'disabled' | 'remote' | 'local';

/** How PigeonBox runs. Mirrors `PigeonBoxMode` in @pigeonbox/api-contract. */
export type RunMode = 'local' | 'cloud';

/** Bumped when stored settings need a migration step. */
export const SETTINGS_VERSION = 3;

export type ExtensionSettings = {
  settingsVersion: number;
  /**
   * `local`: AI runs on this device or with the user's own provider (BYOK/Ollama).
   * `cloud`: AI runs on PigeonBox Cloud. Chosen explicitly by the user; never
   * changed automatically, including when Cloud is unavailable.
   */
  runMode: RunMode;
  /** When the user agreed that Cloud mode sends email content to PigeonBox Cloud. */
  cloudConsentAt: string | null;
  /** Developer override for the Cloud API URL. Blank uses the URL built into this release. */
  cloudApiUrl: string;
  trackingEnabled: boolean;
  trackOpens: boolean;
  trackLinks: boolean;
  /** Release checks contact GitHub only after the user enables this option. */
  automaticUpdateChecks: boolean;
  desktopNotifications: boolean;
  hideSuspectedSelfOpens: boolean;
  trackerBaseUrl: string;
  personalApiToken: string;
  aiMode: AiProcessingMode;
  aiProvider: 'openai' | 'anthropic' | 'gemini' | 'openai-compatible' | 'ollama' | 'chatgpt' | 'chrome' | 'local';
  aiModel: string;
  aiEndpoint: string;
  aiApiKey: string;
  autoClassify: boolean;
  autoSummarize: boolean;
  autoDraft: boolean;
  /** When true, generated drafts are inserted into Gmail. Default off. */
  autoInsertDraft: boolean;
  autoReminders: boolean;
  autoArchive: boolean;
  archiveCategories: ThreadCategory[];
  archiveConfidenceThreshold: number;
  alwaysArchiveSenders: string[];
  neverArchiveSenders: string[];
  reminderMode: 'ai_needed' | 'every_external' | 'disabled';
  reminderBusinessDays: number;
  commandPaletteEnabled: boolean;
  commandPaletteOverrideGmail: boolean;
  inboxSdkAppId: string;
  voiceProfile: VoiceProfile;
  learnFromSent: boolean;
};

export type PublicExtensionSettings = Omit<ExtensionSettings, 'personalApiToken' | 'aiApiKey'> & {
  hasPersonalApiToken: boolean;
  hasAiApiKey: boolean;
  /**
   * Every tracker URL this install's tracking pixels may use: the current one
   * first, then earlier hostnames of the same hosted tracker. Absent means
   * `trackerBaseUrl` only.
   */
  trackerUrls?: string[];
};

export function toPublicSettings(settings: ExtensionSettings): PublicExtensionSettings {
  const { personalApiToken, aiApiKey, ...publicSettings } = settings;
  return {
    ...publicSettings,
    hasPersonalApiToken: Boolean(personalApiToken?.trim()),
    hasAiApiKey: Boolean(aiApiKey?.trim()),
  };
}

export type VoiceProfile = {
  /** How the user signs emails, e.g. "Aiden". Drafts end with the sign-off and this name. */
  name: string;
  /** A line of context for drafts, e.g. "CS student at UC Berkeley". */
  about: string;
  greeting: string;
  signoff: string;
  concision: 'short' | 'medium' | 'long';
  capitalization: 'normal' | 'sentence' | 'title';
  formality: 'casual' | 'neutral' | 'formal';
  emoji: boolean;
  schedulingPreference: string;
  personalInstructions: string;
};

/**
 * Registered InboxSDK app id. A blank setting still uses this so Gmail does not show the unregistered-app warning.
 *
 * Legacy registered InboxSDK identifier. The opaque ID must remain unchanged
 * even though the product is now named PigeonBox (it was registered as "Gmail Intelligence").
 */
export const INBOX_SDK_APP_ID = 'sdk_Intelligence_c698f940a0';

export const DEFAULT_VOICE_PROFILE: VoiceProfile = {
  name: '',
  about: '',
  greeting: 'Hi',
  signoff: 'Thanks',
  concision: 'medium',
  capitalization: 'normal',
  formality: 'neutral',
  emoji: false,
  schedulingPreference: '',
  personalInstructions: '',
};

export const DEFAULT_SETTINGS: ExtensionSettings = {
  settingsVersion: SETTINGS_VERSION,
  runMode: 'local',
  cloudConsentAt: null,
  cloudApiUrl: '',
  trackingEnabled: true,
  trackOpens: true,
  trackLinks: true,
  automaticUpdateChecks: false,
  desktopNotifications: true,
  hideSuspectedSelfOpens: true,
  trackerBaseUrl: '',
  personalApiToken: '',
  aiMode: 'disabled',
  aiProvider: 'openai',
  aiModel: 'gpt-4o-mini',
  aiEndpoint: 'https://api.openai.com/v1',
  aiApiKey: '',
  autoClassify: true,
  autoSummarize: true,
  autoDraft: false,
  autoInsertDraft: false,
  autoReminders: true,
  autoArchive: false,
  archiveCategories: ['NOTIFICATIONS', 'PROMOTIONS', 'NEWS'],
  archiveConfidenceThreshold: 0.95,
  alwaysArchiveSenders: [],
  neverArchiveSenders: [],
  reminderMode: 'ai_needed',
  reminderBusinessDays: 3,
  commandPaletteEnabled: true,
  commandPaletteOverrideGmail: false,
  inboxSdkAppId: INBOX_SDK_APP_ID,
  voiceProfile: DEFAULT_VOICE_PROFILE,
  learnFromSent: false,
};

const AI_PROVIDERS: ReadonlySet<ExtensionSettings['aiProvider']> = new Set([
  'openai',
  'anthropic',
  'gemini',
  'openai-compatible',
  'ollama',
  'chatgpt',
  'chrome',
  'local',
]);

/**
 * Upgrade settings read from `chrome.storage.local` to the current shape.
 *
 * Every field the user saved is kept. Fields added since are filled with
 * defaults. Settings stored before run modes existed (version 1, no
 * `settingsVersion`) always become Local, so an update never starts sending
 * mail to a new destination.
 */
export function migrateSettings(saved: unknown): ExtensionSettings {
  const raw = (saved && typeof saved === 'object' ? saved : {}) as Partial<ExtensionSettings> & Record<string, unknown>;
  const merged: ExtensionSettings = {
    ...DEFAULT_SETTINGS,
    ...raw,
    // Profiles saved before a field existed still get its default.
    voiceProfile: { ...DEFAULT_VOICE_PROFILE, ...(raw.voiceProfile && typeof raw.voiceProfile === 'object' ? raw.voiceProfile : {}) },
  };
  const version = typeof raw.settingsVersion === 'number' ? raw.settingsVersion : 1;
  if (version < 2) {
    merged.runMode = 'local';
    merged.cloudConsentAt = null;
    merged.cloudApiUrl = '';
  }
  if (version < 3) merged.automaticUpdateChecks = false;
  if (merged.runMode !== 'local' && merged.runMode !== 'cloud') merged.runMode = 'local';
  // Cloud mode without recorded consent is not a valid state.
  if (merged.runMode === 'cloud' && !merged.cloudConsentAt) merged.runMode = 'local';
  if (typeof merged.cloudApiUrl !== 'string') merged.cloudApiUrl = '';
  if (!['disabled', 'remote', 'local'].includes(merged.aiMode)) merged.aiMode = 'disabled';
  if (!AI_PROVIDERS.has(merged.aiProvider)) merged.aiProvider = DEFAULT_SETTINGS.aiProvider;
  merged.settingsVersion = SETTINGS_VERSION;
  return merged;
}

export { datesIn, isPastedSummary, localThreadSummary, sanitizeDates, splitSuperseded, tightenSummary } from './local-summary.js';
export type { LocalThreadSummary } from './local-summary.js';

export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let remaining = days;
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return d;
}

export type AIJobKind = 'summary' | 'draft';
export type AIJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export type AIJobRecord = {
  id: string;
  kind: AIJobKind;
  threadId: string;
  fingerprint: string;
  status: AIJobStatus;
  provider?: string;
  model?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
};

export {
  buildThreadSnapshot,
  computeThreadSnapshotFingerprint,
  normalizeSnapshotMessageId,
} from './thread-snapshot.js';
export type {
  RawSnapshotMessage,
  ThreadSnapshot,
  ThreadSnapshotMessage,
} from './thread-snapshot.js';

export * from './thread-state.js';
export * from './business-time.js';

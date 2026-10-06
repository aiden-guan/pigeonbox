/**
 * Real-time Pidgy checks, worker side. The Gmail content script hands over one
 * short clause of an unsent draft; this module decides whether it may leave the
 * extension at all, and passes it to PigeonBox Cloud only when:
 *
 * - the extension is in Cloud mode, signed in, with Cloud sync (never in Local mode);
 * - the user turned on `memory.realtimeComposeChecks` (read from Cloud, cached briefly);
 * - the request has the bounded contract shape.
 *
 * Every failure is a quiet `none`: the check is advisory and must never break
 * typing or sending. Nothing here stores, logs or caches the clause; the
 * content script never receives tokens or other credentials.
 */
import { ComposeCheckRequestSchema, type ComposeCheckNotice, type ComposeCheckRequest, type SourceRef } from '@pigeonbox/api-contract';
import type { PigeonBoxCloudClient } from '@pigeonbox/cloud-client';
import type { CloudState } from '@pigeonbox/core';
import { cloudThreadStateAvailable } from './thread-state';

/** A source the Gmail page may show: no IDs beyond Gmail's own, and only Google Calendar links. */
export type ComposeCheckSource = Pick<SourceRef, 'kind' | 'title' | 'at' | 'gmailThreadId' | 'url'>;
export type ComposeCheckReply =
  | { ok: true; status: 'none' | 'disabled' }
  | { ok: true; status: 'notice'; notice: Pick<ComposeCheckNotice, 'kind' | 'severity' | 'message' | 'suggestedText'> & { sources: ComposeCheckSource[] } };

type Deps = { state: CloudState; runMode: string; client: () => Promise<PigeonBoxCloudClient | null>; now?: () => number };

/** How long the Cloud preference is trusted before it is read again. */
export const PREFERENCE_TTL_MS = 30_000;
/** Defense in depth against a runaway caller: checks per minute this worker will forward. */
export const MAX_CHECKS_PER_MINUTE = 20;
const CHECK_TIMEOUT_MS = 8_000;

let preference: { key: string; enabled: boolean; at: number } | null = null;
let rate = { start: 0, count: 0 };

/** Forget the cached preference, e.g. right after Settings changed it. */
export function forgetComposeCheckPreference(): void {
  preference = null;
}

export function resetComposeCheckForTests(): void {
  preference = null;
  rate = { start: 0, count: 0 };
}

const NONE: ComposeCheckReply = { ok: true, status: 'none' };
const DISABLED: ComposeCheckReply = { ok: true, status: 'disabled' };
const threadIdPattern = /^#?[A-Za-z0-9:_-]{1,64}$/;

/** Copy only contract fields from the untrusted message, then validate the bounded shape. */
export function parseComposeCheck(input: unknown): ComposeCheckRequest | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const candidate = {
    claim: raw.claim,
    subject: typeof raw.subject === 'string' ? raw.subject.slice(0, 998) : '',
    recipientEmails: Array.isArray(raw.recipientEmails) ? raw.recipientEmails.slice(0, 20) : [],
    ...(typeof raw.threadId === 'string' && threadIdPattern.test(raw.threadId) ? { threadId: raw.threadId } : {}),
    ...(typeof raw.mailbox === 'string' && /^[^\s@<>]{1,200}@[^\s@<>]{1,200}$/.test(raw.mailbox) ? { mailbox: raw.mailbox } : {}),
    ...(typeof raw.hint === 'string' ? { hint: raw.hint } : {}),
  };
  const parsed = ComposeCheckRequestSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function safeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const calendar = parsed.protocol === 'https:' && (parsed.hostname === 'calendar.google.com' || (parsed.hostname === 'www.google.com' && parsed.pathname.startsWith('/calendar/')));
    return calendar && !parsed.username && !parsed.password ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function safeSource(source: SourceRef): ComposeCheckSource {
  return {
    kind: source.kind,
    title: source.title.slice(0, 300),
    ...(source.at ? { at: source.at } : {}),
    ...(source.gmailThreadId && /^[A-Za-z0-9_-]{1,64}$/.test(source.gmailThreadId) ? { gmailThreadId: source.gmailThreadId } : {}),
    ...(safeUrl(source.url) ? { url: safeUrl(source.url) } : {}),
  };
}

async function realtimeChecksEnabled(client: PigeonBoxCloudClient, key: string, now: number): Promise<boolean> {
  if (preference && preference.key === key && now - preference.at < PREFERENCE_TTL_MS) return preference.enabled;
  const { preferences } = await client.call('preferences', undefined, { timeoutMs: 5_000 });
  preference = { key, enabled: preferences.memory.realtimeComposeChecks === true, at: now };
  return preference.enabled;
}

/**
 * Whether real-time checks are on for this browser's Cloud account, for the
 * ambient Pidgy in Gmail's composer. Carries and reads no draft text: the same
 * mode gate and cached preference the check itself uses.
 */
export async function handleComposeCheckStatus(deps: Deps): Promise<{ ok: true; enabled: boolean }> {
  if (!cloudThreadStateAvailable(deps.state, deps.runMode)) return { ok: true, enabled: false };
  try {
    const client = await deps.client();
    if (!client) return { ok: true, enabled: false };
    return { ok: true, enabled: await realtimeChecksEnabled(client, `${deps.state.email ?? ''}`, deps.now?.() ?? Date.now()) };
  } catch {
    return { ok: true, enabled: false };
  }
}

export async function handleComposeCheck(input: unknown, deps: Deps): Promise<ComposeCheckReply> {
  const now = deps.now?.() ?? Date.now();
  // Local mode, signed out, or no Cloud sync: the clause never leaves the extension.
  if (!cloudThreadStateAvailable(deps.state, deps.runMode)) return DISABLED;
  const request = parseComposeCheck(input);
  if (!request) return NONE;
  if (now - rate.start >= 60_000) rate = { start: now, count: 0 };
  if (rate.count >= MAX_CHECKS_PER_MINUTE) return NONE;
  try {
    const client = await deps.client();
    if (!client) return DISABLED;
    // The preference is read (or recalled) before the clause is sent anywhere.
    if (!(await realtimeChecksEnabled(client, `${deps.state.email ?? ''}`, now))) return DISABLED;
    rate.count += 1;
    const response = await client.composeCheck(request, { timeoutMs: CHECK_TIMEOUT_MS });
    if (response.status === 'disabled') {
      preference = { key: `${deps.state.email ?? ''}`, enabled: false, at: now };
      return DISABLED;
    }
    if (response.status !== 'notice') return NONE;
    return {
      ok: true,
      status: 'notice',
      notice: {
        kind: response.kind,
        severity: response.severity,
        message: response.message,
        ...(response.suggestedText ? { suggestedText: response.suggestedText } : {}),
        sources: response.sources.slice(0, 4).map(safeSource),
      },
    };
  } catch {
    // Expired session, timeout, budget, outage, invalid response: stay quiet.
    return NONE;
  }
}

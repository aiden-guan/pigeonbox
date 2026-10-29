// Domain helpers shared by control-plane sections.
import { API_BASE, api } from '../lib/session.js';
import { h, pill } from './ui.js';

/** The server this dashboard talks to: its origin, and its host name ("pigeonbox.example.com"). */
export const serverOrigin = () => API_BASE || location.origin;
export const serverHost = () => new URL(serverOrigin()).host;

/**
 * What each server capability is, and the setting that turns it on when this
 * server lacks it. Mirrors CAPABILITY_MESSAGES in packages/server/src/api.ts:
 * every account the server allows gets everything the server is configured for.
 */
export const SERVER_FEATURES = {
  cloud_ai: ['Hosted AI', 'AI on this server needs the CLOUD_AI_* settings. Local AI keeps working without a server.'],
  cloud_tracking: ['Hosted tracking', 'Tracking is not available for this account on this server.'],
  cloud_mail_sync: ['Always-on mail sync', 'Always-on sync needs the Google settings (GOOGLE_*) and DATABASE_URL on this server.'],
  cloud_auto_drafts: ['Background drafts', 'Prepared drafts need the Google settings and DATABASE_URL on this server.'],
  cloud_automations: ['Automations, Smart Views & briefings', 'Smart Views, automations and briefings need the Google settings and DATABASE_URL on this server.'],
  cloud_calendar: ['Calendar', 'Calendar features need the Google settings and DATABASE_URL on this server.'],
  cloud_semantic_search: ['Ask Pigeon over synced mail', 'Ask Pigeon over synced mail needs the Google settings and DATABASE_URL on this server.'],
  cloud_relationships: ['Contacts & relationships', 'Relationship intelligence needs the Google settings and DATABASE_URL on this server.'],
  cloud_documents: ['Tracked documents', 'Tracked documents need DOCUMENTS_BUCKET and DATABASE_URL on this server.'],
  cloud_team: ['Team workspaces', 'Team features need DATABASE_URL on this server.'],
  cloud_mcp: ['API & MCP', 'The developer API needs DATABASE_URL on this server.'],
  cloud_sequences: ['Sequences', 'Sequences need SEQUENCES_ENABLED and the Google settings on this server.'],
};

/** The sentence that says which server setting a missing capability needs. */
export const capabilityHint = (capability) => SERVER_FEATURES[capability]?.[1] ?? 'This server is not configured for it.';

/** Open a thread in Gmail for the right account. */
export function gmailHref(accountEmail, threadId) {
  const user = accountEmail ? `?authuser=${encodeURIComponent(accountEmail)}` : '';
  return `https://mail.google.com/mail/${user}#all/${encodeURIComponent(threadId)}`;
}

export function gmailLink(label, accountEmail, threadId) {
  return h('a', { href: gmailHref(accountEmail, threadId), target: '_blank', rel: 'noopener noreferrer', class: 'thread-link' }, label, h('span', { class: 'sr-only' }, ' (opens Gmail)'));
}

let accountsPromise = null;
/** Connected accounts, cached for this page view. Every fresh answer is announced to the shell. */
export function accounts(refresh = false) {
  if (refresh || !accountsPromise) {
    accountsPromise = api('/v1/connections')
      .then((data) => {
        document.dispatchEvent(new CustomEvent('pigeonbox:accounts', { detail: data }));
        return data;
      })
      .catch((error) => {
        accountsPromise = null;
        throw error;
      });
  }
  return accountsPromise;
}

/** Mirrors syncPhase() in the API contract, for servers that do not send `sync.phase`. */
export function syncPhase(account) {
  const sync = account.sync;
  if (sync.phase) return sync.phase;
  if (account.status === 'needs_reauth') return 'needs_reauth';
  if (account.status === 'paused' || sync.state === 'paused') return 'paused';
  if (account.status === 'error' || sync.state === 'stalled') return 'stalled';
  if (sync.state === 'degraded') return 'degraded';
  if (sync.state === 'initializing') return 'importing';
  if (sync.state === 'recovering') return sync.coverageSince ? 'recovering' : 'importing';
  if (sync.state === 'catching_up' || (sync.syncBacklog ?? 0) > 0) return 'catching_up';
  if ((sync.processingBacklog ?? 0) > 0) return 'analyzing';
  return 'up_to_date';
}

export const PHASES = {
  importing: ['Importing', 'info'],
  recovering: ['Recovering', 'warn'],
  catching_up: ['Catching up', 'info'],
  analyzing: ['Reviewing new mail', 'info'],
  up_to_date: ['Up to date', 'good'],
  degraded: ['Degraded', 'warn'],
  stalled: ['Needs attention', 'bad'],
  needs_reauth: ['Reconnect needed', 'bad'],
  paused: ['Paused', 'neutral'],
};
export const phasePill = (account) => pill(...(PHASES[syncPhase(account)] ?? ['Unknown', 'neutral']));
const MOVING = new Set(['importing', 'recovering', 'catching_up', 'analyzing']);
const TROUBLE = new Set(['needs_reauth', 'stalled', 'degraded']);

/**
 * One answer for the whole account: are the mail routes clear? Derived only
 * from the connection list; never guessed.
 */
export function routeHealth({ accounts: list = [] } = {}) {
  const live = list.filter((account) => account.status !== 'disconnected');
  const phases = live.map((account) => syncPhase(account));
  const trouble = phases.filter((phase) => TROUBLE.has(phase)).length;
  const moving = phases.filter((phase) => MOVING.has(phase)).length;
  const paused = phases.filter((phase) => phase === 'paused').length;
  const lastSync = live.map((account) => account.sync.lastSyncAt).filter(Boolean).sort().at(-1) ?? null;
  if (!live.length) return { tone: 'neutral', phrase: 'No mail routes yet', live, trouble, moving, paused, lastSync };
  if (trouble) return { tone: phases.includes('needs_reauth') || phases.includes('stalled') ? 'bad' : 'warn', phrase: `${trouble} ${trouble === 1 ? 'route needs' : 'routes need'} attention`, live, trouble, moving, paused, lastSync };
  if (paused === live.length) return { tone: 'neutral', phrase: live.length === 1 ? 'Route paused' : 'Routes paused', live, trouble, moving, paused, lastSync };
  if (moving) return { tone: 'info', phrase: 'Sorting new mail', live, trouble, moving, paused, lastSync };
  return { tone: 'good', phrase: live.length === 1 ? 'Route clear' : 'All routes clear', live, trouble, moving, paused, lastSync };
}

export async function accountEmails() {
  try {
    const { accounts: list } = await accounts();
    return new Map(list.map((account) => [account.id, account.email]));
  } catch {
    return new Map();
  }
}

export const FEATURES = {
  mail_read: { title: 'Read and sync mail', detail: 'Keeps triage, follow-ups and drafts current while Gmail is closed.' },
  drafts: { title: 'Create drafts', detail: 'Places prepared drafts in Gmail. Nothing is sent.' },
  organize: { title: 'Organize mail', detail: 'Applies labels and archives for rules you turn on, and makes the changes you allow in Chat. Every rule change is undoable.' },
  calendar_read: { title: 'Read calendar', detail: 'Finds free time and prepares meeting briefs.' },
  calendar_write: { title: 'Add calendar events', detail: 'Creates events after you approve them.' },
  send: { title: 'Send mail', detail: 'Only sends messages you approve. Off unless you turn it on.' },
};

const SYNC = {
  initializing: ['Setting up', 'info'],
  healthy: ['Healthy', 'good'],
  catching_up: ['Catching up', 'info'],
  recovering: ['Recovering', 'warn'],
  degraded: ['Degraded', 'warn'],
  stalled: ['Needs attention', 'bad'],
  paused: ['Paused', 'neutral'],
};
export const syncPill = (state) => pill(...(SYNC[state] ?? [state, 'neutral']));

const STATUS = {
  active: ['Connected', 'good'],
  needs_reauth: ['Reconnect needed', 'bad'],
  paused: ['Paused', 'neutral'],
  error: ['Error', 'bad'],
  disconnected: ['Disconnected', 'neutral'],
};
export const statusPill = (status) => pill(...(STATUS[status] ?? [status, 'neutral']));

const TIERS = ['Internal', 'Reversible', 'Visible change', 'Needs approval'];
export const tierPill = (tier) => pill(`Tier ${tier} · ${TIERS[tier] ?? ''}`, tier >= 3 ? 'warn' : tier === 2 ? 'info' : 'neutral');
/** The risk tier as a postage stamp on an approval. */
export const tierStamp = (tier) =>
  h('span', { class: 'tier-stamp', dataset: { tier: String(tier) }, attrs: { role: 'img', 'aria-label': `Tier ${tier}: ${TIERS[tier] ?? ''}` } }, String(tier), h('small', { attrs: { 'aria-hidden': 'true' } }, TIERS[tier] ?? ''));

export const ACTIONS = {
  classify: 'Classify',
  set_state: 'Set state',
  label: 'Add label',
  remove_label: 'Remove label',
  archive: 'Archive',
  mark_important: 'Mark important',
  star: 'Star',
  snooze: 'Snooze',
  remind: 'Remind me',
  create_task: 'Create task',
  create_note: 'Add note',
  notify: 'Notify me',
  run_analysis: 'Analyze',
  draft_reply: 'Prepare reply',
  draft_follow_up: 'Prepare follow-up',
  prepare_event: 'Prepare event',
  create_event: 'Create event',
  send_email: 'Send email',
};
export const actionLabel = (spec) => `${ACTIONS[spec.kind] ?? spec.kind}${spec.params?.label ? ` “${spec.params.label}”` : ''}`;

export const STATES = {
  NEEDS_REPLY: 'Needs reply',
  WAITING_ON_THEM: 'Waiting on them',
  WAITING_ON_ME: 'Waiting on me',
  FYI: 'FYI',
  NOTIFICATION: 'Notification',
  PROMOTION: 'Promotion',
  NEWS: 'News',
  SCHEDULED: 'Scheduled',
  FOLLOW_UP_DUE: 'Follow-up due',
  DONE: 'Done',
};

/** Download text as a file (CSV export). */
export function download(filename, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const anchor = h('a', { href: '/', download: filename });
  anchor.href = url;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * Server-derived health (`/v1/control/health`). Null when the server predates it,
 * so every caller keeps its connection-only fallback.
 */
export async function cloudHealth() {
  try {
    return await api('/v1/control/health');
  } catch {
    return null;
  }
}

export const HEALTH = {
  healthy: ['Up to date', 'good'],
  syncing: ['Catching up', 'info'],
  degraded: ['Delayed', 'warn'],
  stale: ['Out of date', 'warn'],
  action_required: ['Needs you', 'bad'],
  failed: ['Stopped', 'bad'],
};
export const healthPill = (level) => pill(...(HEALTH[level] ?? ['Unknown', 'neutral']));
export const healthTone = (level) => HEALTH[level]?.[1] ?? 'neutral';

/** Plain words for the server's fixed reason codes. Unknown codes are not shown. */
const REASONS = {
  mail_needs_reauth: 'Google needs you to reconnect.',
  mail_paused: 'Syncing is paused.',
  mail_sync_stalled: 'Syncing stopped after repeated errors.',
  mail_sync_failing: 'Recent syncs keep failing.',
  mail_sync_retrying: 'The last sync failed; PigeonBox is retrying.',
  mail_sync_degraded: 'Syncing is working around an error.',
  mail_backfill_running: 'The first import is still running.',
  mail_recovering: 'Rebuilding recent history.',
  mail_catching_up: 'Syncing new mail.',
  mail_push_pending: 'New mail just arrived and is being synced.',
  mail_push_unprocessed: 'Gmail reported new mail that has not been synced yet.',
  mail_sync_overdue: 'No sync has completed for several hours.',
  mail_watch_expired: 'Gmail notifications lapsed; PigeonBox checks on a schedule instead.',
  mail_dead_sync_jobs: 'Some sync work failed in the last day.',
  calendar_needs_reauth: 'Google needs you to reconnect.',
  calendar_paused: 'Calendar refresh is paused with this account.',
  calendar_refresh_failed: 'The last calendar refresh failed.',
  calendar_first_refresh: 'First calendar refresh is pending.',
  calendar_stale: 'Calendar has not refreshed in over an hour.',
  analysis_catching_up: 'Reviewing new conversations.',
  analysis_delayed: 'Reviewing new conversations is running late.',
  memory_indexing: 'Updating what PigeonBox remembers.',
  drafts_preparing: 'Preparing drafts.',
  background_jobs_failed: 'Some background work failed in the last day.',
};
export const healthReasons = (reasons = []) => reasons.map((code) => REASONS[code]).filter(Boolean);

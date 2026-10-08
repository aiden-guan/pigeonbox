import { chromium, test as base, expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { createServer } from 'node:http';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../../packages/shared/src/index';
import type { TrackedEmail, TrackingEvent } from '../../packages/tracking/src/index';
import { ROUTES, type CloudDraft, type DraftListItem, type RouteName, type ThreadIntel, type SavedTask } from '../../packages/api-contract/src/index';

const accountId = '00000000-0000-4000-8000-000000000001';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-10-01T12:00:00.000Z';
const dashboardFixture = '<!doctype html><title>PigeonBox</title><h1>PigeonBox dashboard</h1><script>const id = new URLSearchParams(location.search).get("ext"); chrome.runtime.sendMessage(id, { type: "HELLO" }, (reply) => { document.body.dataset.hello = reply?.ok === true ? "1" : "0"; });</script>';
const capabilities = [
  'cloud_ai',
  'cloud_tracking',
  'cloud_mail_sync',
  'cloud_auto_drafts',
  'cloud_automations',
  'cloud_semantic_search',
  'cloud_calendar',
  'cloud_relationships',
  'cloud_documents',
];
export const fixtureIntel: ThreadIntel = {
  threadId: 'abc123',
  accountId,
  subject: 'Pricing',
  participants: [{ email: 'maya@fixture.test', name: 'Maya' }],
  lastMessageAt: at,
  lastMessageFromOwner: false,
  state: {
    state: 'NEEDS_REPLY',
    priority: 'HIGH',
    urgency: 'high',
    confidence: 0.9,
    deadline: null,
    importanceReason: 'Asks you directly',
    relationshipImportance: 'known',
    nextAction: { kind: 'reply', label: 'Send pricing' },
    source: 'model',
    updatedAt: at,
  },
  summary: { oneLine: 'Maya asks for pricing.', keyPoints: [] },
  commitments: [],
  followUp: null,
  draft: {
    id: uuid(2),
    accountId,
    threadId: 'abc123',
    kind: 'reply',
    status: 'ready',
    variants: [
      {
        id: uuid(3),
        label: 'recommended',
        strategy: 'Answer',
        body: 'The price is [CONFIRM PRICE].',
        placeholders: [],
      },
      {
        id: uuid(4),
        label: 'shorter',
        strategy: 'Brief',
        body: 'Hi Maya, I’ll send the quote today.',
        placeholders: [],
      },
    ],
    sources: [{ id: 'thread:abc123', kind: 'thread', title: 'Pricing', gmailThreadId: 'abc123', accountId }],
    freshness: { createdAt: at, basedOnMessageId: null, staleReason: null, refreshAfter: null },
    voice: 'default',
    gmailDraftId: null,
    placedVariantId: null,
    errorCode: null,
  },
  injectionSuspected: false,
  analyzedAt: at,
  sources: [],
};
const account = {
  id: accountId,
  provider: 'google',
  email: 'owner@fixture.test',
  displayName: 'Owner',
  status: 'active',
  features: ['mail_read', 'drafts', 'calendar_read'],
  connectedAt: at,
  sync: {
    state: 'healthy',
    lastSyncAt: at,
    lastPushAt: at,
    watchExpiresAt: at,
    backlog: 0,
    syncBacklog: 0,
    processingBacklog: 0,
    lastErrorCode: null,
    coverageSince: at,
    threadsTracked: 1,
  },
};
/** Sync semantics the fixture can switch between. `analyzing`: Gmail current, AI review queued. */
function accountFor(api: FixtureApi) {
  if (api.syncMode === 'analyzing') return { ...account, sync: { ...account.sync, backlog: 12, syncBacklog: 0, processingBacklog: 12, phase: 'analyzing' } };
  if (api.syncMode === 'reauth') return { ...account, status: 'needs_reauth', sync: { ...account.sync, phase: 'needs_reauth' } };
  return { ...account, sync: { ...account.sync, phase: 'up_to_date' } };
}
const draftId = uuid(2);
const fixtureDrafts = (): DraftListItem[] => [
  { draft: fixtureIntel.draft!, subject: 'Pricing', person: { email: 'maya@fixture.test', name: 'Maya' }, lastMessageAt: at },
  {
    draft: { ...fixtureIntel.draft!, id: uuid(20), threadId: 'def456', status: 'placed', gmailDraftId: 'r-fixture', placedVariantId: uuid(21), variants: [{ id: uuid(21), label: 'recommended', strategy: 'Confirm', body: 'Thanks Jordan, Thursday works.', placeholders: [] }] },
    subject: 'Kickoff time', person: { email: 'jordan@fixture.test', name: 'Jordan' }, lastMessageAt: at,
  },
  {
    draft: { ...fixtureIntel.draft!, id: uuid(22), threadId: 'ghi789', status: 'stale', freshness: { ...fixtureIntel.draft!.freshness, staleReason: 'A new message arrived in this thread' }, variants: [{ id: uuid(23), label: 'recommended', strategy: 'Answer', body: 'Hi Sam, here are the notes.', placeholders: [] }] },
    subject: 'Workshop notes', person: { email: 'sam@fixture.test', name: 'Sam' }, lastMessageAt: at,
  },
];
const focus = {
  generatedAt: at,
  sections: [{ id: 'respond', label: 'Needs reply', items: [{ threadId: 'abc123', accountId, subject: 'Pricing', who: 'Maya', lastMessageAt: at, section: 'respond', state: 'NEEDS_REPLY', score: 90, reasons: ['They are waiting on your reply'], deadlineAt: '2026-09-30T12:00:00.000Z', draftReady: true, followUpDueAt: null, draftId: uuid(2), draftStatus: 'ready', approvalId: null, lastMessageFromOwner: false }] }],
  coverage: { syncedAccounts: 1, since: at, note: 'Fixture coverage: one synced conversation.' },
};
const briefing = {
  id: uuid(5),
  kind: 'morning',
  title: 'Your morning briefing',
  generatedAt: at,
  periodStart: at,
  periodEnd: at,
  eventId: null,
  sections: [
    {
      id: 'reply',
      title: 'Needs reply',
      items: [{ text: 'Reply to Maya about pricing.', sourceIds: ['thread:abc123'] }],
    },
  ],
  sources: [{ id: 'thread:abc123', kind: 'thread', title: 'Pricing', gmailThreadId: 'abc123', accountId }],
  coverageNote: 'One connected fixture mailbox.',
};
/** The fixture's Ask Pigeon answer, one-shot or at the end of the stream. */
function fixtureAskAnswer(sources: unknown[], at: string) {
  return {
    answer: 'Maya needs pricing.\n\nShe asked in the **Pricing** thread. [1]',
    claims: [{ text: 'Maya needs pricing.', sourceIds: ['thread:abc123'] }],
    sources,
    coverage: { complete: false, note: 'Only fixture mail was checked.', since: at },
    unverified: [],
    actions: [],
    drafts: [],
    retrieval: { strategies: ['lexical'], candidates: 1, used: 1, window: { from: null, to: null } },
  };
}

function fixturePreferences(realtimeComposeChecks: boolean) {
  return {
    timeZone: 'America/Los_Angeles',
    workdays: [1, 2, 3, 4, 5],
    workingHours: { start: '09:00', end: '17:30' },
    followUp: { defaultBusinessDays: 3, remindIfOpenedNoReply: false, remindWhenRevived: true, prepareDraftMorningOf: true, morningAt: '08:30' },
    autoDrafts: { enabled: true, placeInGmail: false, kinds: ['reply'], learnFromEdits: true },
    calendar: { bufferMinutes: 10, avoidBackToBack: true, preferMornings: false, defaultDurationMinutes: 30, focusBlocks: [] },
    memory: { enabled: true, learnFromReceivedMail: true, learnFromSentMail: true, learnFromDraftEdits: true, realtimeComposeChecks },
    fastRecall: { enabled: false, retentionDays: 90 },
    briefings: { morning: { enabled: true, at: '08:00' }, endOfDay: { enabled: false, at: '17:30' }, meeting: { enabled: true, minutesBefore: 30, externalOnly: true } },
    notifications: { extension: true, web: true, followUpsDue: true, approvals: true, engagement: false },
    webResearch: false,
    voice: null,
  };
}

export type FixtureApi = {
  /** Answer the streaming Ask route with 404, like an older Cloud. */
  noStream?: boolean;
  partial: boolean;
  disconnected: boolean;
  delay: number;
  askDelay?: number;
  fail: boolean;
  /** Zero "while away" activity, as right after reopening the panel. */
  quiet: boolean;
  syncMode: 'idle' | 'analyzing' | 'reauth';
  /** Serve Cloud preferences with Real-time Pidgy checks on or off. Unset: no preferences route, as before. */
  composeChecks?: boolean;
  composeAmbient?: boolean;
  documentPreviews?: Record<string, string>;
  engagement?: boolean;
  calls: { route: string; body: Record<string, unknown> }[];
  baseUrl: string;
  tracker?: { senderLink?: { clickId: string; destination: string }; email: TrackedEmail; events: TrackingEvent[]; holdClaims: boolean; release: () => void };
  /** Serve tracker routes from a real tracker implementation instead of the synthetic `tracker`. */
  forward?: (request: Request) => Promise<Response>;
};
type App = {
  context: BrowserContext;
  worker: Worker;
  id: string;
  api: FixtureApi;
  page: (name: string, cloud?: boolean) => Promise<Page>;
  gmail: () => Promise<Page>;
};
export const test = base.extend<{ app: App }>({
  app: async ({}, use) => {
    const api: FixtureApi = { partial: false, disconnected: false, delay: 0, fail: false, quiet: false, syncMode: 'idle', calls: [], baseUrl: '' };
    const placed = new Map<string, CloudDraft>();
    let tasks: SavedTask[] = [];
    const heldClaims: Array<() => void> = [];
    const server = createServer(async (request, response) => {
      const route = new URL(request.url!, 'http://fixture.test').pathname;
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', '*');
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT');
        response.end();
        return;
      }
      let raw = '';
      for await (const chunk of request) raw += chunk;
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        /* synthetic PDF bytes */
      }
      api.calls.push({ route, body });
      if (api.forward && (route === '/health' || /^\/(api|open|c)\//.test(route))) {
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) if (typeof value === 'string' && name !== 'host') headers.set(name, value);
        const forwarded = await api.forward(new Request(`${api.baseUrl}${request.url}`, { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method!) ? undefined : raw }));
        response.statusCode = forwarded.status;
        forwarded.headers.forEach((value, name) => response.setHeader(name, value));
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.end(Buffer.from(await forwarded.arrayBuffer()));
        return;
      }
      if (route === '/dashboard') {
        // A stand-in for the dashboard (Settings): like the real page, it says HELLO so the extension knows its tab.
        response.setHeader('Content-Type', 'text/html');
        response.end(dashboardFixture);
        return;
      }
      if (api.tracker && (route.startsWith('/api/') || route.startsWith('/open/'))) {
        const tracker = api.tracker;
        tracker.release = () => { tracker.holdClaims = false; heldClaims.splice(0).forEach((resolve) => resolve()); };
        if (route.startsWith('/open/')) {
          const timestamp = new Date().toISOString();
          tracker.events.push({ id: 'own-reload-proxy', tracking_id: tracker.email.tracking_id, type: 'OPEN', timestamp, classification: 'PROXY_LIKELY', user_agent: 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)' });
          tracker.email.open_count += 1; tracker.email.first_opened_at = timestamp; tracker.email.last_opened_at = timestamp;
          response.setHeader('Content-Type', 'image/gif');
          response.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')); return;
        }
        if (tracker.senderLink && route === `/api/links/${tracker.senderLink.clickId}`) {
          response.end(JSON.stringify({ tracking_id: tracker.email.tracking_id, destination: tracker.senderLink.destination })); return;
        }
        if (route.endsWith('/self-view')) {
          if (tracker.holdClaims) await new Promise<void>((resolve) => heldClaims.push(resolve));
          const reclassifiedEventIds = tracker.events.filter((event) => event.classification === 'PROXY_LIKELY').map((event) => event.id);
          tracker.events.forEach((event) => { if (reclassifiedEventIds.includes(event.id)) { event.classification = 'SELF_LIKELY'; event.suspected_self_open = true; } });
          const opens = tracker.events.filter((event) => event.type === 'OPEN' && event.classification === 'RECIPIENT_LIKELY');
          tracker.email.open_count = opens.length; tracker.email.first_opened_at = opens[0]?.timestamp || null; tracker.email.last_opened_at = opens.at(-1)?.timestamp || null;
          response.end(JSON.stringify({ ok: true, open_count: tracker.email.open_count, reclassifiedEventIds, first_opened_at: tracker.email.first_opened_at, last_opened_at: tracker.email.last_opened_at, click_count: 0, first_clicked_at: null, last_clicked_at: null })); return;
        }
        const data = route === '/api/emails' ? [tracker.email] : route.endsWith('/events') || route === '/api/events/recent' ? tracker.events : tracker.email;
        response.end(JSON.stringify(data)); return;
      }
      const def = Object.entries(ROUTES).find(([, value]) => value.path === route && value.method === request.method)?.[0] as RouteName | undefined;
      let data: unknown;
      if (route === '/v1/capabilities') data = { plan: 'cloud', capabilities };
      else if (def === 'documentPreview') data = { url: api.documentPreviews?.[String(body.token)] ?? null };
      else if (def === 'connections')
        data = { accounts: api.disconnected ? [] : [accountFor(api)], googleConfigured: true, maxAccounts: 5 };
      else if (def === 'cloudOverview') {
        if (api.delay) await new Promise((resolve) => setTimeout(resolve, api.delay));
        if (api.fail) {
          response.statusCode = 503;
          response.end(JSON.stringify({ error: { code: 'internal', message: 'Unavailable', retryable: true } }));
          return;
        }
        data = {
          generatedAt: at,
          since: at,
          accounts: api.disconnected ? [] : [accountFor(api)],
          work: api.quiet ? { threadsAnalyzed: 0, draftsPrepared: 0, followUpsDetected: 0, approvalsWaiting: 1 } : { threadsAnalyzed: 7, draftsPrepared: 2, followUpsDetected: 1, approvalsWaiting: 1 },
          prepared: { drafts: { ready: 1, inGmail: 1, needsUpdate: 1, preparing: 0 }, followUpsOpen: 2, approvalsWaiting: 1 },
          focus,
          latestBriefing: api.partial ? null : briefing,
          automatic: { views: [], automations: [], runs: [] },
          unavailable: api.partial ? ['briefing'] : [],
        };
      } else if (def === 'draftList') {
        const statuses = (body.statuses as string[] | undefined) ?? null;
        const drafts = fixtureDrafts().map((item) => ({ ...item, draft: placed.get(item.draft.id) ?? item.draft }));
        const counts = { preparing: 0, ready: 0, stale: 0, user_edited: 0, placed: 0, failed: 0 };
        for (const item of drafts) counts[item.draft.status as keyof typeof counts] += 1;
        data = { drafts: drafts.filter((item) => !statuses || statuses.includes(item.draft.status)), counts, nextCursor: null };
      } else if (def === 'draftPlace') {
        const source = fixtureDrafts().find((item) => item.draft.id === body.draftId)!.draft;
        const next: CloudDraft = { ...source, status: 'placed', gmailDraftId: 'r-placed', placedVariantId: String(body.variantId) };
        placed.set(next.id, next);
        data = { draft: next };
      } else if (def === 'draftPrepare') {
        data = { draft: { ...fixtureDrafts()[2]!.draft, status: 'ready', freshness: { ...fixtureIntel.draft!.freshness, staleReason: null }, variants: [{ id: uuid(24), label: 'recommended', strategy: 'Updated', body: 'Hi Sam, updated notes attached.', placeholders: [] }] } };
      } else if (def === 'threadsIntel')
        data = {
          threads: Object.fromEntries(
            (body.threadIds as string[]).filter((id) => id === 'abc123').map((id) => [id, { ...fixtureIntel, draft: placed.get(draftId) ?? fixtureIntel.draft }]),
          ),
          synced: true,
          accountId,
        };
      else if (def === 'askPigeonStream') {
        // Like a Cloud that predates streaming, so the extension falls back to askPigeon.
        if (api.noStream) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } }));
          return;
        }
        response.setHeader('Content-Type', 'application/x-ndjson');
        const write = (event: unknown) => response.write(`${JSON.stringify(event)}\n`);
        const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        write({ type: 'status', text: 'Searching Gmail: pricing' });
        await pause(150 + (api.askDelay ?? 0));
        write({ type: 'status', text: 'Reading "Pricing"' });
        await pause(400);
        write({ type: 'delta', text: 'Maya needs ' });
        await pause(400);
        write({ type: 'delta', text: 'pricing. [S' });
        await pause(100);
        write({ type: 'done', response: fixtureAskAnswer(briefing.sources, at) });
        response.end();
        return;
      } else if (def === 'askPigeon') {
        if (api.askDelay) await new Promise((resolve) => setTimeout(resolve, api.askDelay));
        await new Promise((resolve) => setTimeout(resolve, 300));
        data = fixtureAskAnswer(briefing.sources, at);
      } else if (def === 'preferences' && api.composeChecks !== undefined) data = { preferences: fixturePreferences(api.composeChecks) };
      else if (def === 'composeCheck')
        // A calendar-backed answer: busy tomorrow 2–4 PM, free otherwise.
        data = api.composeAmbient && /any meetings left today/i.test(String(body.claim))
          ? { status: 'notice', kind: 'calendar_conflict', severity: 'warning', message: 'You have Meeting with Alex from 12–12:30 PM today.', confidence: 0.98, highlightText: 'i dont have any meetings', sources: [{ id: 'event:meeting', kind: 'calendar_event', title: 'Meeting with Alex', url: 'https://calendar.google.com/calendar/event?eid=meeting' }] }
          : api.composeAmbient && /any upcoming hackathons/i.test(String(body.claim))
          ? { status: 'notice', kind: 'overlooked_context', severity: 'info', message: 'You have CalHacks Oct 23–25.', confidence: 0.96, highlightText: 'any upcoming hackathons', sources: [{ id: 'event:calhacks', kind: 'calendar_event', title: 'CalHacks', url: 'https://calendar.google.com/calendar/event?eid=calhacks' }] }
          : /\bfree tomorrow at 3\b/i.test(String(body.claim))
          ? {
              status: 'notice',
              kind: 'calendar_conflict',
              severity: 'warning',
              message: 'You have Math 52 from 2–4 PM tomorrow.',
              confidence: 0.98,
              suggestedText: "I'm free tomorrow at 4:30.",
              sources: [{ id: 'event:math52', kind: 'calendar_event', title: 'Math 52', url: 'https://calendar.google.com/calendar/event?eid=math52' }],
            }
          : { status: 'none' };
      else if (def === 'tasks') data = { tasks };
      else if (def === 'taskCreate') { tasks.push({ id: String(body.id), title: String(body.title), threadId: body.threadId ? String(body.threadId) : null, accountId: body.threadId ? accountId : null, dueAt: null, status: 'open', createdAt: at }); data = { tasks }; }
      else if (def === 'taskUpdate') { tasks = tasks.map((task) => task.id === body.id ? { ...task, status: body.status as SavedTask['status'] } : task); data = { tasks }; }
      else if (def === 'approvals') data = { approvals: [], pending: 0 };
      else if (def === 'followUps') data = { followUps: api.engagement ? [{ subject: 'Waiting on pricing', who: 'Maya', followUp: { id: uuid(80), threadId: 'abc123', accountId, stage: 'waiting', expectedFrom: ['maya@fixture.test'], dueAt: at, reason: 'You asked for confirmation.', rule: 'manual', lastOutboundAt: at, lastInboundAt: null, engagement: null, draftId: null, snoozedUntil: null } }] : [] };
      else if (def === 'threadSignals') data = { signals: [], events: [{ at, type: 'open', eventClass: 'RECIPIENT_LIKELY', confidence: 0.9, explanation: 'A recipient open was observed.' }], attributionNote: 'Opens are observations, not proof of reading.' };
      else if (def === 'auditList') data = { events: [], nextCursor: null };
      else if (def === 'automationRuns') data = { runs: [] };
      else if (def === 'briefings') data = { briefings: [briefing] };
      else if (def === 'briefingGet' || def === 'briefingGenerate') data = { briefing };
      else if (def === 'views') data = { views: [] };
      else if (def === 'automations') data = { automations: [] };
      else if (def === 'documents') data = { documents: [] };
      else if (def === 'documentCreate')
        data = {
          document: {
            id: uuid(9),
            title: body.title,
            filename: body.filename,
            sizeBytes: 0,
            pageCount: null,
            status: 'uploading',
            createdAt: at,
            links: 0,
            views: 0,
            lastViewedAt: null,
          },
        };
      else if (route === `/v1/documents/${uuid(9)}/content` && request.method === 'PUT') {
        data = {
          document: {
            id: uuid(9),
            title: 'Proposal',
            filename: 'Proposal.pdf',
            sizeBytes: Buffer.byteLength(raw),
            pageCount: 1,
            status: 'ready',
            createdAt: at,
            links: 0,
            views: 0,
            lastViewedAt: null,
          },
        };
      } else if (def === 'documentLinkCreate')
        data = {
          link: {
            id: uuid(10),
            documentId: body.documentId,
            url: `${api.baseUrl}/d/${'a'.repeat(30)}`,
            recipientEmail: body.recipientEmail ?? null,
            expiresAt: body.expiresAt ?? null,
            allowDownload: body.allowDownload ?? false,
            watermark: body.watermark ?? true,
            revokedAt: null,
            threadId: null,
            createdAt: at,
          },
        };
      else if (def === 'viewCompile')
        data = {
          draft: {
            name: 'Receipts',
            filter: { subjectAny: ['receipt'] },
            actions: [{ kind: 'archive', params: {} }],
            explanation: ['Subject contains receipt'],
            warnings: [],
            usesAi: false,
            confidence: 0.9,
          },
        };
      else if (def === 'viewSave') {
        data = {
          view: {
            id: uuid(6),
            name: 'Receipts',
            prompt: body.prompt,
            filter: body.filter,
            actions: body.actions,
            mode: body.mode,
            enabled: true,
            usesAi: false,
            priority: 50,
            version: 1,
            activation: { eligible: false, reason: 'Review five decisions first', required: 5, confirmed: 0 },
            explanation: ['Subject contains receipt'],
            createdAt: at,
            updatedAt: at,
            stats: {
              matched: 0,
              applied: 0,
              shadowDecisions: 0,
              confirmed: 0,
              corrected: 0,
              undone: 0,
              lastRunAt: null,
            },
          },
        };
      } else {
        response.statusCode = 404;
        response.end(
          JSON.stringify({ error: { code: 'not_found', message: 'Fixture route not configured.', retryable: false } }),
        );
        return;
      }
      const checked = def ? ROUTES[def].response.safeParse(data) : { success: true, data };
      if (!checked.success) {
        response.statusCode = 500;
        response.end(
          JSON.stringify({ error: { code: 'internal', message: 'Fixture schema is invalid.', retryable: false } }),
        );
        return;
      }
      response.end(JSON.stringify(checked.data));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    api.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const profile = await mkdtemp(path.join(os.tmpdir(), 'pigeonbox-e2e-'));
    let closeContext: BrowserContext | undefined;
    try {
    const extension = path.join(profile, 'extension');
    await cp(path.resolve(process.env.PIGEONBOX_BROWSER_EXTENSION_PATH || 'apps/extension/dist'), extension, { recursive: true });
    await rm(path.join(extension, 'tracker-config.json'), { force: true });
    const context = await chromium.launchPersistentContext(path.join(profile, 'browser'), {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      viewport: { width: 1280, height: 900 },
      recordVideo: process.env.PIGEONBOX_MOTION_QA ? { dir: 'test-results/dispatch-videos', size: { width: 1280, height: 900 } } : undefined,
    });
    closeContext = context;
    // Local release builds open the published origin. Keep its dashboard synthetic
    // while exercising Chrome's real externally_connectable boundary and HELLO.
    await context.route('https://usepigeonbox.com/dashboard**', (route) => route.fulfill({ contentType: 'text/html', body: dashboardFixture }));
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const id = worker.url().split('/')[2];
    await context.route('https://mail.google.com/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body style="font-family:Arial"><a href="https://accounts.google.com/" aria-label="Google Account: Owner (owner@fixture.test)">Owner</a><input aria-label="Search mail"><div role="main" data-thread-perm-id="abc123"><h2 class="hP">Pricing</h2><div data-legacy-message-id="abcd"><span email="maya@fixture.test">Maya</span><div class="a3s">Can you send a quote?</div></div><button aria-label="Reply">Reply</button><div role="region" aria-label="Reply"><input name="draft" value="abc999"><div contenteditable="true" aria-label="Message Body" style="min-height:80px">Existing text</div><button aria-label="Send" onclick="document.body.dataset.sent=\'true\'">Send</button></div></div></body></html>',
      }),
    );
    const app: App = {
      context,
      worker,
      id,
      api,
      page: async (name, cloud = false) => {
        const setup = await context.newPage();
        await setup.goto(`chrome-extension://${id}/settings.html?here`);
        await setup.evaluate(
          async ({ defaults, baseUrl, cloud, name }) => {
            await chrome.runtime.sendMessage({
              type: 'SAVE_SETTINGS',
              settings: {
                ...defaults,
                aiMode: 'disabled',
                inboxSdkAppId: '',
                trackingEnabled: false,
                cloudApiUrl: baseUrl,
              },
            });
            if (cloud) {
              await chrome.storage.session.set({
                cloudAccess: {
                  apiBaseUrl: baseUrl,
                  accessToken: 'fixture-access-only',
                  expiresAt: Math.floor(Date.now() / 1000) + 3600,
                },
              });
              await chrome.storage.local.set({
                cloudSession: {
                  apiBaseUrl: baseUrl,
                  refreshToken: 'fixture-refresh-only',
                  user: { id: 'fixture-user', email: 'owner@fixture.test' },
                },
              });
              await chrome.runtime.sendMessage({ type: 'SET_RUN_MODE', mode: 'cloud', consent: true });
              const checked = await chrome.runtime.sendMessage({ type: 'CLOUD_REFRESH' });
              if (checked?.state?.cloud?.status !== 'ready') throw new Error('Synthetic Cloud session did not become ready');
            }
            await chrome.storage.local.set({ workspaceState: { mode: cloud ? 'home' : 'inbox', splitCategory: 'RESPOND', cloudSection: 'overview', display: name === 'sidepanel' ? 'dock' : 'float', open: true } });
          },
          { defaults: DEFAULT_SETTINGS, baseUrl: api.baseUrl, cloud, name },
        );
        if (name === 'sidepanel') await setup.setViewportSize({ width: 420, height: 900 });
        // settings.html forwards to the dashboard; `?here` keeps the in-extension page.
        await setup.goto(`chrome-extension://${id}/${name}.html${name === 'settings' ? '?here' : ''}`);
        return setup;
      },
      gmail: async () => {
        await worker.evaluate(async () => { const stored = await chrome.storage.local.get('workspaceState'); await chrome.storage.local.set({ workspaceState: { ...stored.workspaceState, mode: 'home', cloudSection: 'overview', display: 'float', open: true } }); });
        const page = await context.newPage();
        await page.goto('https://mail.google.com/mail/u/0/#inbox/abc123');
        return page;
      },
    };
      await use(app);
    } finally {
      api.tracker?.release();
      await closeContext?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profile, { recursive: true, force: true });
    }
  },
});
export { expect };

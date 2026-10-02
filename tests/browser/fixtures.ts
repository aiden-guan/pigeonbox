import { chromium, test as base, expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { createServer } from 'node:http';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../../packages/shared/src/index';
import { ROUTES, type RouteName, type ThreadIntel } from '../../packages/api-contract/src/index';

const accountId = '00000000-0000-4000-8000-000000000001';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-10-01T12:00:00.000Z';
const capabilities = [
  'cloud_ai',
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
    lastErrorCode: null,
    coverageSince: at,
    threadsTracked: 1,
  },
};
const focus = {
  generatedAt: at,
  sections: [{ id: 'respond', label: 'Needs reply', items: [{ threadId: 'abc123', accountId, subject: 'Pricing', who: 'Maya', lastMessageAt: at, section: 'respond', state: 'NEEDS_REPLY', score: 90, reasons: ['Reply requested'], deadlineAt: null, draftReady: true, followUpDueAt: null }] }],
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
export type FixtureApi = {
  partial: boolean;
  disconnected: boolean;
  delay: number;
  fail: boolean;
  calls: { route: string; body: Record<string, unknown> }[];
  baseUrl: string;
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
    const api: FixtureApi = { partial: false, disconnected: false, delay: 0, fail: false, calls: [], baseUrl: '' };
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
      const def = Object.entries(ROUTES).find(([, value]) => value.path === route)?.[0] as RouteName | undefined;
      let data: unknown;
      if (route === '/v1/capabilities') data = { plan: 'cloud', capabilities };
      else if (def === 'connections')
        data = { accounts: api.disconnected ? [] : [account], googleConfigured: true, maxAccounts: 5 };
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
          accounts: api.disconnected ? [] : [account],
          work: { threadsAnalyzed: 7, draftsPrepared: 2, followUpsDetected: 1, approvalsWaiting: 1 },
          focus,
          latestBriefing: api.partial ? null : briefing,
          automatic: { views: [], automations: [], runs: [] },
          unavailable: api.partial ? ['briefing'] : [],
        };
      } else if (def === 'threadsIntel')
        data = {
          threads: Object.fromEntries(
            (body.threadIds as string[]).filter((id) => id === 'abc123').map((id) => [id, fixtureIntel]),
          ),
          synced: true,
          accountId,
        };
      else if (def === 'askPigeon') {
        await new Promise((resolve) => setTimeout(resolve, 300));
        data = {
          answer: 'Maya needs pricing.',
          claims: [{ text: 'Maya needs pricing.', sourceIds: ['thread:abc123'] }],
          sources: briefing.sources,
          coverage: { complete: false, note: 'Only fixture mail was checked.', since: at },
          unverified: [],
          actions: [],
          drafts: [],
          retrieval: { strategies: ['lexical'], candidates: 1, used: 1, window: { from: null, to: null } },
        };
      } else if (def === 'approvals') data = { approvals: [], pending: 0 };
      else if (def === 'followUps') data = { followUps: [], generatedAt: at };
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
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const id = worker.url().split('/')[2];
    await context.route('https://mail.google.com/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body style="font-family:Arial"><a aria-label="Google Account: Owner (owner@fixture.test)">Owner</a><input aria-label="Search mail"><div role="main" data-thread-perm-id="abc123"><h2 class="hP">Pricing</h2><div data-legacy-message-id="abcd"><span email="maya@fixture.test">Maya</span><div class="a3s">Can you send a quote?</div></div><button aria-label="Reply">Reply</button><div role="region" aria-label="Reply"><input name="draft" value="abc999"><div contenteditable="true" aria-label="Message Body" style="min-height:80px">Existing text</div><button aria-label="Send" onclick="document.body.dataset.sent=\'true\'">Send</button></div></div></body></html>',
      }),
    );
    const app: App = {
      context,
      worker,
      id,
      api,
      page: async (name, cloud = false) => {
        const setup = await context.newPage();
        await setup.goto(`chrome-extension://${id}/popup.html`);
        await setup.evaluate(
          async ({ defaults, baseUrl, cloud }) => {
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
            await chrome.storage.session.set({ panelState: { mode: cloud ? 'cloud' : 'inbox' } });
          },
          { defaults: DEFAULT_SETTINGS, baseUrl: api.baseUrl, cloud },
        );
        if (name === 'sidepanel') await setup.setViewportSize({ width: 420, height: 900 });
        await setup.goto(`chrome-extension://${id}/${name}.html`);
        return setup;
      },
      gmail: async () => {
        const page = await context.newPage();
        await page.goto('https://mail.google.com/mail/u/0/#inbox/abc123');
        return page;
      },
    };
      await use(app);
    } finally {
      await closeContext?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profile, { recursive: true, force: true });
    }
  },
});
export { expect };

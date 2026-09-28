import {
  extractTrackingIdFromMessageBody,
  normalizeGmailId,
  type TrackedEmailSummary,
} from '@pigeonbox/tracking';
import { resolveMessageId, resolveThreadId, type MessageIdView, type ThreadIdView } from '@pigeonbox/gmail';

const THREAD_RECOVERY_WINDOW_MS = 48 * 60 * 60 * 1000;

export type InboxSdkMessageViewLike = MessageIdView & {
  getViewState?: () => string;
  getBodyElement?: () => HTMLElement | null;
  getThreadView?: () => ThreadIdView | null | undefined;
  on?: (event: string, cb: (payload?: any) => void) => void;
  destroyed?: boolean;
};

export type SelfViewSource =
  | 'ROW_INTERACTION'
  | 'MESSAGE_EXPANDED'
  | 'MESSAGE_LOAD'
  | 'CACHE_REINSPECTION'
  | 'PAGE_RELOAD';

export type PageReloadContext = {
  navigationStartedAt: number;
};

/** Stable id for one document reload. Repeated inspections of the same message share it. */
export function buildSelfViewEventId(
  trackingId: string,
  gmailMessageId: string | null | undefined,
  source: SelfViewSource,
  observedAt: number,
): string {
  if (source === 'PAGE_RELOAD') {
    return `sv_${trackingId}_PAGE_RELOAD_${observedAt}`;
  }
  const messageId = normalizeGmailId(gmailMessageId);
  return `sv_${trackingId}_${messageId || 'nomessage'}_${source}_${observedAt}`;
}

/** Backwards-compatible alias */
export type MessageSelfViewTrigger =
  | SelfViewSource
  | 'message-expanded'
  | 'message-load'
  | 'cache-reinspection';

export type SelfViewDiagnostic = {
  reason: 'unresolved' | 'ambiguous_pixel';
  gmailMessageId: string | null;
  gmailThreadId: string | null;
};

export interface MessageSelfViewController {
  handleMessageView(messageView: InboxSdkMessageViewLike): void;
  reinspectActive(): Promise<void>;
  getActiveCount(): number;
  destroy(): void;
}

export type ActiveMessageViewState = {
  view: InboxSdkMessageViewLike;
  expandedAt: number | null;
  loadedAt: number | null;
  lastReportedTrackingId?: string;
  lastReportedMessageId?: string;
  lastExpandedClaimAt?: number;
  lastLoadedClaimAt?: number;
  pendingPageReload?: boolean;
};

export function createMessageSelfViewHandler(opts: {
  getEmails: () => TrackedEmailSummary[];
  getTrackerBaseUrl?: () => string | null | undefined;
  pageReload?: PageReloadContext | null;
  onSelfView: (
    trackingId: string,
    gmailThreadId: string | null,
    gmailMessageId: string | null,
    observedAt: number,
    trigger: SelfViewSource,
  ) => void;
  onReconcile?: (trackingId: string, gmailThreadId: string | null, gmailMessageId: string | null) => void;
  onDiagnostic?: (info: SelfViewDiagnostic) => void;
  onCollapsed?: (trackingId: string, gmailMessageId: string | null) => void;
}): MessageSelfViewController {
  const activeMessageViews = new Map<InboxSdkMessageViewLike, ActiveMessageViewState>();
  const pageReloadReported = new Set<string>();

  async function inspectMessageView(
    state: ActiveMessageViewState,
    source: SelfViewSource = 'MESSAGE_EXPANDED',
    specificTimestamp?: number,
  ): Promise<void> {
    const messageView = state.view;
    try {
      if (messageView.destroyed) {
        activeMessageViews.delete(messageView);
        return;
      }

      const viewState = typeof messageView.getViewState === 'function' ? messageView.getViewState() : null;
      if (viewState !== 'EXPANDED') {
        return;
      }

      // Determine observation time based on source
      let observedAt: number;
      if (source === 'MESSAGE_LOAD') {
        observedAt = specificTimestamp ?? state.loadedAt ?? Date.now();
        state.loadedAt = observedAt;
      } else {
        observedAt = specificTimestamp ?? state.expandedAt ?? Date.now();
        state.expandedAt = observedAt;
      }

      const rawMessageId = await resolveMessageId(messageView);
      const messageId = normalizeGmailId(rawMessageId);
      const threadView = typeof messageView.getThreadView === 'function' ? messageView.getThreadView() : null;
      const rawThreadId = threadView ? await resolveThreadId(threadView) : null;
      const viewThreadId = normalizeGmailId(rawThreadId);
      const emails = opts.getEmails();
      const trackerBaseUrl = opts.getTrackerBaseUrl?.() || undefined;
      const body = typeof messageView.getBodyElement === 'function' ? messageView.getBodyElement() : null;
      const pixelTrackingId = body ? extractTrackingIdFromMessageBody(body, trackerBaseUrl) : null;

      let trackingId: string | null = null;
      let identity: 'pixel' | 'message_id' | 'thread' | null = null;
      let stored: TrackedEmailSummary | undefined;

      if (pixelTrackingId) {
        trackingId = pixelTrackingId;
        identity = 'pixel';
        stored = emails.find((item) => item.trackingId === pixelTrackingId);
      } else if (messageId) {
        stored = emails.find((item) => normalizeGmailId(item.gmailMessageId) === messageId);
        if (stored) {
          trackingId = stored.trackingId;
          identity = 'message_id';
        }
      }

      if (!trackingId && viewThreadId) {
        const candidates = emails.filter((item) => {
          if (normalizeGmailId(item.gmailThreadId) !== viewThreadId) return false;
          if (normalizeGmailId(item.gmailMessageId)) return false;
          const sent = item.sentAt ? Date.parse(item.sentAt) : Number.NaN;
          if (!Number.isFinite(sent)) return false;
          if (sent > observedAt + 60_000) return false;
          return observedAt - sent <= THREAD_RECOVERY_WINDOW_MS;
        });
        if (candidates.length === 1) {
          stored = candidates[0];
          trackingId = stored.trackingId;
          identity = 'thread';
        }
      }

      if (!trackingId || !identity) {
        const stillLoading = typeof messageView.isLoaded === 'function' && !messageView.isLoaded();
        if (stillLoading) return;
        const info: SelfViewDiagnostic = {
          reason: 'unresolved',
          gmailMessageId: messageId,
          gmailThreadId: viewThreadId,
        };
        if (opts.onDiagnostic) opts.onDiagnostic(info);
        else console.debug('[gi][self-view] unresolved message view', info);
        return;
      }

      const threadId = viewThreadId || normalizeGmailId(stored?.gmailThreadId);
      const navigationStartedAt = opts.pageReload?.navigationStartedAt;
      if (
        state.pendingPageReload &&
        navigationStartedAt != null &&
        Number.isFinite(navigationStartedAt) &&
        // Gmail often replaces the original image URL with a Google proxy URL.
        // An exact saved message id is also enough to identify our sent message.
        (identity === 'pixel' || identity === 'message_id') &&
        trackingId
      ) {
        if (!pageReloadReported.has(trackingId)) {
          pageReloadReported.add(trackingId);
          opts.onSelfView(trackingId, threadId, messageId, navigationStartedAt, 'PAGE_RELOAD');
        }
        state.pendingPageReload = false;
      }

      const storedMessageId = normalizeGmailId(stored?.gmailMessageId);
      const shouldReconcile = Boolean(
        messageId &&
          (identity === 'pixel' || identity === 'thread') &&
          (!stored || storedMessageId !== messageId),
      );

      if (source === 'MESSAGE_LOAD') {
        if (
          state.lastReportedTrackingId === trackingId &&
          state.lastReportedMessageId === (messageId || undefined) &&
          state.lastLoadedClaimAt === observedAt
        ) {
          return;
        }
        state.lastLoadedClaimAt = observedAt;
      } else if (source === 'MESSAGE_EXPANDED') {
        if (
          state.lastReportedTrackingId === trackingId &&
          state.lastReportedMessageId === (messageId || undefined) &&
          state.lastExpandedClaimAt === observedAt
        ) {
          return;
        }
        state.lastExpandedClaimAt = observedAt;
      } else if (source === 'CACHE_REINSPECTION') {
        if (state.lastReportedTrackingId === trackingId && state.lastReportedMessageId === (messageId || undefined)) {
          return;
        }
      }

      state.lastReportedTrackingId = trackingId;
      state.lastReportedMessageId = messageId || undefined;

      if (shouldReconcile) {
        opts.onReconcile?.(trackingId, threadId, messageId);
      }
      opts.onSelfView(trackingId, threadId, messageId, observedAt, source);
    } catch (error) {
      console.warn('[gi][self-view] Message view inspection error', error);
    }
  }

  function handleMessageView(messageView: InboxSdkMessageViewLike): void {
    let state = activeMessageViews.get(messageView);
    const created = !state;
    if (!state) {
      state = {
        view: messageView,
        expandedAt: null,
        loadedAt: null,
      };
      activeMessageViews.set(messageView, state);
    }

    if (typeof messageView.on === 'function') {
      messageView.on('destroy', () => {
        activeMessageViews.delete(messageView);
      });

      messageView.on('viewStateChange', (event?: { newViewState?: string }) => {
        const currentState = typeof messageView.getViewState === 'function'
          ? messageView.getViewState()
          : event?.newViewState;
        if (currentState === 'EXPANDED') {
          state.expandedAt = Date.now();
          void inspectMessageView(state, 'MESSAGE_EXPANDED', state.expandedAt);
        } else {
          if (state.lastReportedTrackingId) {
            opts.onCollapsed?.(state.lastReportedTrackingId, state.lastReportedMessageId || null);
          }
          state.expandedAt = null;
          state.loadedAt = null;
          state.pendingPageReload = false;
          state.lastExpandedClaimAt = undefined;
          state.lastLoadedClaimAt = undefined;
          state.lastReportedTrackingId = undefined;
          state.lastReportedMessageId = undefined;
        }
      });

      messageView.on('load', () => {
        const currentState = typeof messageView.getViewState === 'function'
          ? messageView.getViewState()
          : null;
        if (currentState === 'EXPANDED') {
          state.loadedAt = Date.now();
          void inspectMessageView(state, 'MESSAGE_LOAD', state.loadedAt);
        }
      });
    }

    const initial = typeof messageView.getViewState === 'function' ? messageView.getViewState() : null;
    if (
      created &&
      initial === 'EXPANDED' &&
      opts.pageReload &&
      Number.isFinite(opts.pageReload.navigationStartedAt)
    ) {
      state.pendingPageReload = true;
    }
    if (initial === 'EXPANDED') {
      if (!state.expandedAt) {
        state.expandedAt = Date.now();
      }
      void inspectMessageView(state, 'MESSAGE_EXPANDED', state.expandedAt);
    }
  }

  async function reinspectActive(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const state of [...activeMessageViews.values()]) {
      const mv = state.view;
      if (mv.destroyed) {
        activeMessageViews.delete(mv);
        continue;
      }
      const viewState = typeof mv.getViewState === 'function' ? mv.getViewState() : null;
      if (viewState === 'EXPANDED') {
        if (!state.expandedAt) {
          state.expandedAt = Date.now();
        }
        promises.push(inspectMessageView(state, 'CACHE_REINSPECTION', state.expandedAt));
      }
    }
    await Promise.all(promises);
  }

  return {
    handleMessageView,
    reinspectActive,
    getActiveCount: () => activeMessageViews.size,
    destroy: () => {
      activeMessageViews.clear();
    },
  };
}

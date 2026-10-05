import { TasksSchema, TaskCreateSchema, TaskUpdateSchema } from './tasks.js';
import { MemoryListRequestSchema, MemoryListResponseSchema, MemoryIdRequestSchema, MemoryResponseSchema, MemoryUpdateRequestSchema, MemoryPurgeRequestSchema, MemoryPurgeResponseSchema } from './memory.js';
import type { z } from 'zod';
import {
  AccountDeleteRequestSchema,
  BillingCheckoutRequestSchema,
  BillingPortalRequestSchema,
  BillingRedirectResponseSchema,
  CapabilitiesResponseSchema,
  EntitlementsResponseSchema,
  HealthResponseSchema,
  MeResponseSchema,
  VersionResponseSchema,
} from './account.js';
import {
  AskRequestSchema,
  AskResponseSchema,
  ClassifyRequestSchema,
  ClassifyResponseSchema,
  DraftRequestSchema,
  DraftResponseSchema,
  EmbedRequestSchema,
  EmbedResponseSchema,
  RewriteRequestSchema,
  RewriteResponseSchema,
  SummarizeRequestSchema,
  SummarizeResponseSchema,
  type AiOperation,
} from './ai.js';
import {
  OkResponseSchema,
  RefreshRequestSchema,
  SessionResponseSchema,
  SignOutRequestSchema,
  TokenExchangeRequestSchema,
} from './auth.js';
import {
  ApprovalDecideRequestSchema,
  ApprovalListRequestSchema,
  ApprovalListResponseSchema,
  ApprovalResponseSchema,
  AuditListRequestSchema,
  AuditListResponseSchema,
  AutomationCompileRequestSchema,
  AutomationCompileResponseSchema,
  AutomationIdRequestSchema,
  AutomationResponseSchema,
  AutomationRunRequestSchema,
  AutomationRunResponseSchema,
  AutomationRunsRequestSchema,
  AutomationRunsResponseSchema,
  AutomationSaveRequestSchema,
  AutomationsResponseSchema,
  UndoRequestSchema,
  UndoResponseSchema,
  ViewCompileRequestSchema,
  ViewCompileResponseSchema,
  ViewHistoryResponseSchema,
  ViewIdRequestSchema,
  ViewResponseSchema,
  ViewResultsRequestSchema,
  ViewResultsResponseSchema,
  ViewReviewRequestSchema,
  ViewSaveRequestSchema,
  ViewShadowResponseSchema,
  ViewsResponseSchema,
} from './automation.js';
import {
  AvailabilityRequestSchema,
  AvailabilityResponseSchema,
  BriefingGenerateRequestSchema,
  BriefingGetRequestSchema,
  BriefingResponseSchema,
  BriefingsListRequestSchema,
  BriefingsListResponseSchema,
  EventCreateRequestSchema,
  EventPrepareRequestSchema,
  EventResponseSchema,
  MeetingBriefRequestSchema,
  MeetingBriefResponseSchema,
  ScheduleProposeRequestSchema,
  ScheduleProposeResponseSchema,
} from './calendar.js';
import type { PigeonBoxCapability } from './capabilities.js';
import {
  ConnectStartRequestSchema,
  ConnectStartResponseSchema,
  ConnectionDisconnectRequestSchema,
  ConnectionResponseSchema,
  ConnectionResyncRequestSchema,
  ConnectionUpdateRequestSchema,
  ConnectionsResponseSchema,
} from './connections.js';
import {
  DocumentAnalyticsRequestSchema,
  DocumentCreateRequestSchema,
  DocumentResponseSchema,
  DocumentAnalyticsResponseSchema,
  DocumentLinkCreateRequestSchema,
  DocumentLinkResponseSchema,
  DocumentLinkRevokeRequestSchema,
  DocumentsResponseSchema,
} from './documents.js';
import { CloudOverviewRequestSchema, CloudOverviewResponseSchema } from './overview.js';
import {
  DraftFeedbackRequestSchema,
  DraftGetRequestSchema,
  DraftListRequestSchema,
  DraftListResponseSchema,
  DraftPlaceRequestSchema,
  DraftPrepareRequestSchema,
  CloudDraftResponseSchema,
  FocusQueueRequestSchema,
  FocusQueueResponseSchema,
  FollowUpListRequestSchema,
  FollowUpListResponseSchema,
  FollowUpUpdateRequestSchema,
  FollowUpUpdateResponseSchema,
  PreferencesResponseSchema,
  PreferencesUpdateRequestSchema,
  ThreadStateUpdateRequestSchema,
  ThreadStateUpdateResponseSchema,
  ThreadsIntelRequestSchema,
  ThreadsIntelResponseSchema,
} from './mail.js';
import { NotificationsAckRequestSchema, NotificationsRequestSchema, NotificationsResponseSchema } from './notifications.js';
import {
  ContactBriefRequestSchema,
  ContactBriefResponseSchema,
  ContactListRequestSchema,
  ContactListResponseSchema,
  ContactResponseSchema,
  ContactUpdateRequestSchema,
  RadarResponseSchema,
  ThreadSignalsRequestSchema,
  ThreadSignalsResponseSchema,
} from './relationships.js';
import { AskFeedbackRequestSchema, AskPigeonRequestSchema, AskPigeonResponseSchema, AskStreamEventSchema } from './research.js';
import {
  AssignRequestSchema,
  AssignmentUpdateRequestSchema,
  CommentAddRequestSchema,
  SharedThreadResponseSchema,
  SnippetDeleteRequestSchema,
  SnippetRenderRequestSchema,
  SnippetRenderResponseSchema,
  SnippetResponseSchema,
  SnippetSaveRequestSchema,
  SnippetsResponseSchema,
  ThreadTeamRequestSchema,
  ThreadTeamResponseSchema,
  WorkspacesResponseSchema,
} from './team.js';

export type RouteAuth = 'none' | 'user';

export type RouteDef = {
  method: 'GET' | 'POST';
  path: string;
  auth: RouteAuth;
  request?: z.ZodTypeAny;
  response: z.ZodTypeAny;
  /** Set on routes that run inference; these are metered and entitlement-checked. */
  operation?: AiOperation;
  /**
   * The Cloud capability the account needs. The server refuses the route with
   * `entitlement_required` without it; clients hide the feature instead of
   * calling. Routes without a capability need only a signed-in user.
   */
  capability?: PigeonBoxCapability;
  /**
   * Set on routes that answer with a stream of newline-delimited JSON events
   * instead of one JSON body. `response` then validates each event, and
   * clients read them with `stream()` rather than `call()`.
   */
  stream?: 'ndjson';
};

/**
 * The canonical PigeonBox Cloud route table. The client and the server both
 * build from this object, so a route cannot exist on one side only.
 */
export const ROUTES = {
  health: { method: 'GET', path: '/v1/health', auth: 'none', response: HealthResponseSchema },
  version: { method: 'GET', path: '/v1/version', auth: 'none', response: VersionResponseSchema },

  authToken: { method: 'POST', path: '/v1/auth/token', auth: 'none', request: TokenExchangeRequestSchema, response: SessionResponseSchema },
  authRefresh: { method: 'POST', path: '/v1/auth/refresh', auth: 'none', request: RefreshRequestSchema, response: SessionResponseSchema },
  authSignOut: { method: 'POST', path: '/v1/auth/signout', auth: 'user', request: SignOutRequestSchema, response: OkResponseSchema },

  me: { method: 'GET', path: '/v1/me', auth: 'user', response: MeResponseSchema },
  capabilities: { method: 'GET', path: '/v1/capabilities', auth: 'user', response: CapabilitiesResponseSchema },
  entitlements: { method: 'GET', path: '/v1/account/entitlements', auth: 'user', response: EntitlementsResponseSchema },
  accountDelete: { method: 'POST', path: '/v1/account/delete', auth: 'user', request: AccountDeleteRequestSchema, response: OkResponseSchema },

  billingCheckout: { method: 'POST', path: '/v1/billing/checkout', auth: 'user', request: BillingCheckoutRequestSchema, response: BillingRedirectResponseSchema },
  billingPortal: { method: 'POST', path: '/v1/billing/portal', auth: 'user', request: BillingPortalRequestSchema, response: BillingRedirectResponseSchema },

  classify: { method: 'POST', path: '/v1/ai/classify', auth: 'user', request: ClassifyRequestSchema, response: ClassifyResponseSchema, operation: 'classify' },
  summarize: { method: 'POST', path: '/v1/ai/summarize', auth: 'user', request: SummarizeRequestSchema, response: SummarizeResponseSchema, operation: 'summarize' },
  draft: { method: 'POST', path: '/v1/ai/draft', auth: 'user', request: DraftRequestSchema, response: DraftResponseSchema, operation: 'draft' },
  followUp: { method: 'POST', path: '/v1/ai/follow-up', auth: 'user', request: DraftRequestSchema, response: DraftResponseSchema, operation: 'follow_up' },
  rewrite: { method: 'POST', path: '/v1/ai/rewrite', auth: 'user', request: RewriteRequestSchema, response: RewriteResponseSchema, operation: 'rewrite' },
  ask: { method: 'POST', path: '/v1/ai/ask', auth: 'user', request: AskRequestSchema, response: AskResponseSchema, operation: 'ask' },
  embed: { method: 'POST', path: '/v1/ai/embed', auth: 'user', request: EmbedRequestSchema, response: EmbedResponseSchema, operation: 'embed' },

  // Cloud-only Google connection (always-on sync). Protocol 1, additive.
  connections: { method: 'GET', path: '/v1/connections', auth: 'user', response: ConnectionsResponseSchema, capability: 'cloud_mail_sync' },
  connectStart: { method: 'POST', path: '/v1/connections/google/start', auth: 'user', request: ConnectStartRequestSchema, response: ConnectStartResponseSchema, capability: 'cloud_mail_sync' },
  connectionUpdate: { method: 'POST', path: '/v1/connections/update', auth: 'user', request: ConnectionUpdateRequestSchema, response: ConnectionResponseSchema, capability: 'cloud_mail_sync' },
  connectionDisconnect: { method: 'POST', path: '/v1/connections/disconnect', auth: 'user', request: ConnectionDisconnectRequestSchema, response: OkResponseSchema },
  connectionResync: { method: 'POST', path: '/v1/connections/resync', auth: 'user', request: ConnectionResyncRequestSchema, response: ConnectionResponseSchema, capability: 'cloud_mail_sync' },
  preferences: { method: 'GET', path: '/v1/preferences', auth: 'user', response: PreferencesResponseSchema, capability: 'cloud_mail_sync' },
  preferencesUpdate: { method: 'POST', path: '/v1/preferences/update', auth: 'user', request: PreferencesUpdateRequestSchema, response: PreferencesResponseSchema, capability: 'cloud_mail_sync' },

  // Thread state, Focus Queue, drafts and follow-ups.
  cloudOverview: { method: 'POST', path: '/v1/overview', auth: 'user', request: CloudOverviewRequestSchema, response: CloudOverviewResponseSchema, capability: 'cloud_mail_sync' },
  threadsIntel: { method: 'POST', path: '/v1/threads/intel', auth: 'user', request: ThreadsIntelRequestSchema, response: ThreadsIntelResponseSchema, capability: 'cloud_mail_sync' },
  threadStateUpdate: { method: 'POST', path: '/v1/threads/state', auth: 'user', request: ThreadStateUpdateRequestSchema, response: ThreadStateUpdateResponseSchema, capability: 'cloud_mail_sync' },
  focusQueue: { method: 'POST', path: '/v1/focus/queue', auth: 'user', request: FocusQueueRequestSchema, response: FocusQueueResponseSchema, capability: 'cloud_mail_sync' },
  draftList: { method: 'POST', path: '/v1/drafts/list', auth: 'user', request: DraftListRequestSchema, response: DraftListResponseSchema, capability: 'cloud_auto_drafts' },
  draftGet: { method: 'POST', path: '/v1/drafts/get', auth: 'user', request: DraftGetRequestSchema, response: CloudDraftResponseSchema, capability: 'cloud_auto_drafts' },
  draftPrepare: { method: 'POST', path: '/v1/drafts/prepare', auth: 'user', request: DraftPrepareRequestSchema, response: CloudDraftResponseSchema, capability: 'cloud_auto_drafts' },
  draftPlace: { method: 'POST', path: '/v1/drafts/place', auth: 'user', request: DraftPlaceRequestSchema, response: CloudDraftResponseSchema, capability: 'cloud_auto_drafts' },
  draftFeedback: { method: 'POST', path: '/v1/drafts/feedback', auth: 'user', request: DraftFeedbackRequestSchema, response: OkResponseSchema, capability: 'cloud_auto_drafts' },
  followUps: { method: 'POST', path: '/v1/followups/list', auth: 'user', request: FollowUpListRequestSchema, response: FollowUpListResponseSchema, capability: 'cloud_mail_sync' },
  followUpUpdate: { method: 'POST', path: '/v1/followups/update', auth: 'user', request: FollowUpUpdateRequestSchema, response: FollowUpUpdateResponseSchema, capability: 'cloud_mail_sync' },

  // Personal context controls stay available after a subscription ends.
  memoryList: { method: 'POST', path: '/v1/memory/list', auth: 'user', request: MemoryListRequestSchema, response: MemoryListResponseSchema },
  memoryGet: { method: 'POST', path: '/v1/memory/get', auth: 'user', request: MemoryIdRequestSchema, response: MemoryResponseSchema },
  memoryForget: { method: 'POST', path: '/v1/memory/forget', auth: 'user', request: MemoryIdRequestSchema, response: OkResponseSchema },
  memoryUpdate: { method: 'POST', path: '/v1/memory/update', auth: 'user', request: MemoryUpdateRequestSchema, response: MemoryResponseSchema },
  memoryPurge: { method: 'POST', path: '/v1/memory/purge', auth: 'user', request: MemoryPurgeRequestSchema, response: MemoryPurgeResponseSchema },

  // Ask Pigeon.
  tasks: { method: 'GET', path: '/v1/tasks', auth: 'user', response: TasksSchema, capability: 'cloud_mail_sync' },
  taskCreate: { method: 'POST', path: '/v1/tasks', auth: 'user', request: TaskCreateSchema, response: TasksSchema, capability: 'cloud_mail_sync' },
  taskUpdate: { method: 'POST', path: '/v1/tasks/update', auth: 'user', request: TaskUpdateSchema, response: TasksSchema, capability: 'cloud_mail_sync' },
  askPigeon: { method: 'POST', path: '/v1/ask', auth: 'user', request: AskPigeonRequestSchema, response: AskPigeonResponseSchema, capability: 'cloud_semantic_search' },
  askPigeonStream: { method: 'POST', path: '/v1/ask/stream', auth: 'user', request: AskPigeonRequestSchema, response: AskStreamEventSchema, capability: 'cloud_semantic_search', stream: 'ndjson' },
  askFeedback: { method: 'POST', path: '/v1/ask/feedback', auth: 'user', request: AskFeedbackRequestSchema, response: OkResponseSchema, capability: 'cloud_semantic_search' },

  // Calendar Copilot and briefings.
  calendarAvailability: { method: 'POST', path: '/v1/calendar/availability', auth: 'user', request: AvailabilityRequestSchema, response: AvailabilityResponseSchema, capability: 'cloud_calendar' },
  schedulePropose: { method: 'POST', path: '/v1/calendar/propose', auth: 'user', request: ScheduleProposeRequestSchema, response: ScheduleProposeResponseSchema, capability: 'cloud_calendar' },
  eventPrepare: { method: 'POST', path: '/v1/calendar/events/prepare', auth: 'user', request: EventPrepareRequestSchema, response: EventResponseSchema, capability: 'cloud_calendar' },
  eventCreate: { method: 'POST', path: '/v1/calendar/events/create', auth: 'user', request: EventCreateRequestSchema, response: EventResponseSchema, capability: 'cloud_calendar' },
  meetingBrief: { method: 'POST', path: '/v1/calendar/meeting-brief', auth: 'user', request: MeetingBriefRequestSchema, response: MeetingBriefResponseSchema, capability: 'cloud_calendar' },
  briefings: { method: 'POST', path: '/v1/briefings/list', auth: 'user', request: BriefingsListRequestSchema, response: BriefingsListResponseSchema, capability: 'cloud_automations' },
  briefingGet: { method: 'POST', path: '/v1/briefings/get', auth: 'user', request: BriefingGetRequestSchema, response: BriefingResponseSchema, capability: 'cloud_automations' },
  briefingGenerate: { method: 'POST', path: '/v1/briefings/generate', auth: 'user', request: BriefingGenerateRequestSchema, response: BriefingResponseSchema, capability: 'cloud_automations' },

  // Relationships and engagement signals.
  contacts: { method: 'POST', path: '/v1/contacts/list', auth: 'user', request: ContactListRequestSchema, response: ContactListResponseSchema, capability: 'cloud_relationships' },
  contactBrief: { method: 'POST', path: '/v1/contacts/brief', auth: 'user', request: ContactBriefRequestSchema, response: ContactBriefResponseSchema, capability: 'cloud_relationships' },
  contactUpdate: { method: 'POST', path: '/v1/contacts/update', auth: 'user', request: ContactUpdateRequestSchema, response: ContactResponseSchema, capability: 'cloud_relationships' },
  radar: { method: 'GET', path: '/v1/contacts/radar', auth: 'user', response: RadarResponseSchema, capability: 'cloud_relationships' },
  threadSignals: { method: 'POST', path: '/v1/signals/thread', auth: 'user', request: ThreadSignalsRequestSchema, response: ThreadSignalsResponseSchema, capability: 'cloud_tracking' },

  // Smart Views with Shadow Mode.
  views: { method: 'GET', path: '/v1/views', auth: 'user', response: ViewsResponseSchema, capability: 'cloud_automations' },
  viewCompile: { method: 'POST', path: '/v1/views/compile', auth: 'user', request: ViewCompileRequestSchema, response: ViewCompileResponseSchema, capability: 'cloud_automations' },
  viewSave: { method: 'POST', path: '/v1/views/save', auth: 'user', request: ViewSaveRequestSchema, response: ViewResponseSchema, capability: 'cloud_automations' },
  viewDelete: { method: 'POST', path: '/v1/views/delete', auth: 'user', request: ViewIdRequestSchema, response: OkResponseSchema, capability: 'cloud_automations' },
  viewResults: { method: 'POST', path: '/v1/views/results', auth: 'user', request: ViewResultsRequestSchema, response: ViewResultsResponseSchema, capability: 'cloud_automations' },
  viewShadow: { method: 'POST', path: '/v1/views/shadow', auth: 'user', request: ViewIdRequestSchema, response: ViewShadowResponseSchema, capability: 'cloud_automations' },
  viewReview: { method: 'POST', path: '/v1/views/review', auth: 'user', request: ViewReviewRequestSchema, response: ViewShadowResponseSchema, capability: 'cloud_automations' },
  viewActivate: { method: 'POST', path: '/v1/views/activate', auth: 'user', request: ViewIdRequestSchema, response: ViewResponseSchema, capability: 'cloud_automations' },
  viewHistory: { method: 'POST', path: '/v1/views/history', auth: 'user', request: ViewIdRequestSchema, response: ViewHistoryResponseSchema, capability: 'cloud_automations' },

  // Automations, approvals and audit.
  automations: { method: 'GET', path: '/v1/automations', auth: 'user', response: AutomationsResponseSchema, capability: 'cloud_automations' },
  automationCompile: { method: 'POST', path: '/v1/automations/compile', auth: 'user', request: AutomationCompileRequestSchema, response: AutomationCompileResponseSchema, capability: 'cloud_automations' },
  automationSave: { method: 'POST', path: '/v1/automations/save', auth: 'user', request: AutomationSaveRequestSchema, response: AutomationResponseSchema, capability: 'cloud_automations' },
  automationDelete: { method: 'POST', path: '/v1/automations/delete', auth: 'user', request: AutomationIdRequestSchema, response: OkResponseSchema, capability: 'cloud_automations' },
  automationRun: { method: 'POST', path: '/v1/automations/run', auth: 'user', request: AutomationRunRequestSchema, response: AutomationRunResponseSchema, capability: 'cloud_automations' },
  automationRuns: { method: 'POST', path: '/v1/automations/runs', auth: 'user', request: AutomationRunsRequestSchema, response: AutomationRunsResponseSchema, capability: 'cloud_automations' },
  approvals: { method: 'POST', path: '/v1/approvals/list', auth: 'user', request: ApprovalListRequestSchema, response: ApprovalListResponseSchema },
  approvalDecide: { method: 'POST', path: '/v1/approvals/decide', auth: 'user', request: ApprovalDecideRequestSchema, response: ApprovalResponseSchema },
  auditList: { method: 'POST', path: '/v1/audit/list', auth: 'user', request: AuditListRequestSchema, response: AuditListResponseSchema },
  actionUndo: { method: 'POST', path: '/v1/audit/undo', auth: 'user', request: UndoRequestSchema, response: UndoResponseSchema },

  // Team and snippets.
  workspaces: { method: 'GET', path: '/v1/workspaces', auth: 'user', response: WorkspacesResponseSchema, capability: 'cloud_team' },
  threadTeam: { method: 'POST', path: '/v1/team/thread', auth: 'user', request: ThreadTeamRequestSchema, response: ThreadTeamResponseSchema, capability: 'cloud_team' },
  assign: { method: 'POST', path: '/v1/team/assign', auth: 'user', request: AssignRequestSchema, response: SharedThreadResponseSchema, capability: 'cloud_team' },
  assignmentUpdate: { method: 'POST', path: '/v1/team/assignment', auth: 'user', request: AssignmentUpdateRequestSchema, response: SharedThreadResponseSchema, capability: 'cloud_team' },
  commentAdd: { method: 'POST', path: '/v1/team/comment', auth: 'user', request: CommentAddRequestSchema, response: SharedThreadResponseSchema, capability: 'cloud_team' },
  snippets: { method: 'GET', path: '/v1/snippets', auth: 'user', response: SnippetsResponseSchema, capability: 'cloud_ai' },
  snippetSave: { method: 'POST', path: '/v1/snippets/save', auth: 'user', request: SnippetSaveRequestSchema, response: SnippetResponseSchema, capability: 'cloud_ai' },
  snippetDelete: { method: 'POST', path: '/v1/snippets/delete', auth: 'user', request: SnippetDeleteRequestSchema, response: OkResponseSchema, capability: 'cloud_ai' },
  snippetRender: { method: 'POST', path: '/v1/snippets/render', auth: 'user', request: SnippetRenderRequestSchema, response: SnippetRenderResponseSchema, capability: 'cloud_ai' },

  // Tracked documents.
  documentCreate: { method: 'POST', path: '/v1/documents/create', auth: 'user', request: DocumentCreateRequestSchema, response: DocumentResponseSchema, capability: 'cloud_documents' },
  documents: { method: 'GET', path: '/v1/documents', auth: 'user', response: DocumentsResponseSchema, capability: 'cloud_documents' },
  documentLinkCreate: { method: 'POST', path: '/v1/documents/links/create', auth: 'user', request: DocumentLinkCreateRequestSchema, response: DocumentLinkResponseSchema, capability: 'cloud_documents' },
  documentLinkRevoke: { method: 'POST', path: '/v1/documents/links/revoke', auth: 'user', request: DocumentLinkRevokeRequestSchema, response: DocumentLinkResponseSchema, capability: 'cloud_documents' },
  documentAnalytics: { method: 'POST', path: '/v1/documents/analytics', auth: 'user', request: DocumentAnalyticsRequestSchema, response: DocumentAnalyticsResponseSchema, capability: 'cloud_documents' },

  // Notifications for the extension and web app.
  notifications: { method: 'POST', path: '/v1/notifications/list', auth: 'user', request: NotificationsRequestSchema, response: NotificationsResponseSchema },
  notificationsAck: { method: 'POST', path: '/v1/notifications/ack', auth: 'user', request: NotificationsAckRequestSchema, response: OkResponseSchema },
} as const satisfies Record<string, RouteDef>;

export type RouteName = keyof typeof ROUTES;
export type RouteRequest<N extends RouteName> = (typeof ROUTES)[N] extends { request: infer S extends z.ZodTypeAny }
  ? z.input<S>
  : never;
export type RouteResponse<N extends RouteName> = z.infer<(typeof ROUTES)[N]['response']>;

/**
 * Browser redirect (not JSON), so it lives outside ROUTES. Query shape is
 * `AuthorizeQuerySchema`.
 */
export const AUTHORIZE_PATH = '/v1/auth/authorize';

/** Browser redirect target after Google consent for a Cloud connection. Server-side only. */
export const GOOGLE_CONNECT_CALLBACK_PATH = '/v1/connections/google/callback';

/**
 * Hosted tracker management routes. They reuse the self-host tracker protocol
 * (see @pigeonbox/tracking) and authenticate with the Cloud access token instead
 * of a personal token. Pixel and click routes stay public.
 */
export const TRACKER_PATHS = {
  health: '/health',
  emails: '/api/emails',
  recentEvents: '/api/events/recent',
  openPixelPrefix: '/open/',
  clickPrefix: '/c/',
} as const;

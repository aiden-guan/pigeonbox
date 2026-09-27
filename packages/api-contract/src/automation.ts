import { RelationshipImportanceSchema, ThreadStateSchema } from '@pigeonbox/shared';
import { z } from 'zod';
import { CursorSchema, GmailIdSchema, IdSchema, IdempotencyKeySchema, IsoSchema, RiskTierSchema, SourceRefSchema } from './common.js';

/**
 * Smart Views, Shadow Mode, automations, the approval queue and the audit log.
 *
 * Every action has a risk tier:
 *   0 read-only (summarize, classify, suggest)          → may run automatically
 *   1 reversible mailbox change (label, archive, snooze) → automatic only after the user enables the rule; audited and undoable
 *   2 externally visible draft or state (Gmail draft, prepared event) → automatic if the user enables it
 *   3 external side effect (send, invite, revoke)        → always needs explicit approval
 */

export const ACTION_KINDS = [
  'classify',
  'set_state',
  'label',
  'remove_label',
  'archive',
  'mark_important',
  'star',
  'snooze',
  'remind',
  'create_task',
  'create_note',
  'notify',
  'run_analysis',
  'draft_reply',
  'draft_follow_up',
  'prepare_event',
  'create_event',
  'send_email',
] as const;
export const ActionKindSchema = z.enum(ACTION_KINDS);
export type ActionKind = z.infer<typeof ActionKindSchema>;

export const ActionSpecSchema = z.object({
  kind: ActionKindSchema,
  params: z.record(z.string().max(40), z.union([z.string().max(500), z.number(), z.boolean()])).default({}),
});
export type ActionSpec = z.infer<typeof ActionSpecSchema>;

const Addresses = z.array(z.string().min(1).max(320)).max(100);

/**
 * An explainable filter. Deterministic fields are evaluated exactly; `aiCriteria`
 * is used only when the request cannot be expressed without judgment (for
 * example "important recruiting emails"), and is shown to the user as such.
 */
export const FilterSpecSchema = z.object({
  /** Email addresses or domains (`@example.com` or `example.com`). */
  from: z.object({ include: Addresses, exclude: Addresses }).default({ include: [], exclude: [] }),
  to: z.object({ include: Addresses, exclude: Addresses }).default({ include: [], exclude: [] }),
  states: z.array(ThreadStateSchema).max(10).default([]),
  labels: z.object({ include: z.array(z.string().max(100)).max(20), exclude: z.array(z.string().max(100)).max(20) }).default({ include: [], exclude: [] }),
  subjectAny: z.array(z.string().min(1).max(100)).max(20).default([]),
  keywordsAny: z.array(z.string().min(1).max(100)).max(20).default([]),
  direction: z.enum(['inbound', 'outbound', 'any']).default('any'),
  deadlineWithinDays: z.number().int().min(0).max(365).nullable().default(null),
  /** Outbound threads with no reply for this many business days. */
  noReplyForBusinessDays: z.number().int().min(1).max(60).nullable().default(null),
  relationship: z.array(RelationshipImportanceSchema).max(5).default([]),
  engagement: z.enum(['opened', 'clicked', 'no_engagement']).nullable().default(null),
  /** The user opened mail from this sender before (e.g. "newsletters I actually read"). */
  readByUser: z.boolean().nullable().default(null),
  receivedWithinDays: z.number().int().min(1).max(3_650).nullable().default(null),
  hasAttachment: z.boolean().nullable().default(null),
  aiCriteria: z.string().max(500).nullable().default(null),
});
export type FilterSpec = z.infer<typeof FilterSpecSchema>;

export const ViewModeSchema = z.enum(['view', 'shadow', 'active']);

export const RuleStatsSchema = z.object({
  matched: z.number().int().nonnegative(),
  shadowDecisions: z.number().int().nonnegative(),
  confirmed: z.number().int().nonnegative(),
  corrected: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  undone: z.number().int().nonnegative(),
  lastRunAt: IsoSchema.nullable(),
});

export const ActivationSchema = z.object({
  eligible: z.boolean(),
  reason: z.string().max(200),
  required: z.number().int().nonnegative(),
  confirmed: z.number().int().nonnegative(),
});

export const SmartViewSchema = z.object({
  id: IdSchema,
  name: z.string().max(120),
  prompt: z.string().max(500),
  filter: FilterSpecSchema,
  /** The criteria in plain words, one per line. */
  explanation: z.array(z.string().max(200)).max(20),
  usesAi: z.boolean(),
  actions: z.array(ActionSpecSchema).max(8),
  mode: ViewModeSchema,
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(100),
  version: z.number().int().positive(),
  stats: RuleStatsSchema,
  activation: ActivationSchema,
  createdAt: IsoSchema,
  updatedAt: IsoSchema,
});
export type SmartView = z.infer<typeof SmartViewSchema>;

export const ViewDraftSchema = z.object({
  name: z.string().max(120),
  filter: FilterSpecSchema,
  explanation: z.array(z.string().max(200)).max(20),
  usesAi: z.boolean(),
  actions: z.array(ActionSpecSchema).max(8),
  warnings: z.array(z.string().max(200)).max(8),
  confidence: z.number().min(0).max(1),
});

export const ViewCompileRequestSchema = z.object({ prompt: z.string().min(3).max(500) });
export const ViewCompileResponseSchema = z.object({ draft: ViewDraftSchema });
export const ViewsResponseSchema = z.object({ views: z.array(SmartViewSchema).max(100) });
export const ViewSaveRequestSchema = z.object({
  id: IdSchema.optional(),
  name: z.string().min(1).max(120),
  prompt: z.string().max(500),
  filter: FilterSpecSchema,
  actions: z.array(ActionSpecSchema).max(8).default([]),
  /** New rules with mailbox-changing actions always start in shadow mode, whatever is requested. */
  mode: ViewModeSchema.default('view'),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(100).default(50),
});
export const ViewResponseSchema = z.object({ view: SmartViewSchema });
export const ViewIdRequestSchema = z.object({ id: IdSchema });
export const ViewResultsRequestSchema = z.object({ id: IdSchema, limit: z.number().int().min(1).max(100).default(40) });
export const ViewMatchSchema = z.object({
  threadId: GmailIdSchema,
  accountId: IdSchema,
  subject: z.string().max(998),
  who: z.string().max(320),
  lastMessageAt: IsoSchema,
  why: z.array(z.string().max(200)).max(8),
  confidence: z.number().min(0).max(1),
});
export const ViewResultsResponseSchema = z.object({ items: z.array(ViewMatchSchema).max(100), evaluatedAt: IsoSchema, note: z.string().max(300) });

export const ShadowDecisionSchema = z.object({
  id: IdSchema,
  viewId: IdSchema,
  threadId: GmailIdSchema,
  subject: z.string().max(998),
  who: z.string().max(320),
  /** What PigeonBox would have done. Nothing was changed in Gmail. */
  actions: z.array(ActionSpecSchema).max(8),
  why: z.array(z.string().max(200)).max(8),
  confidence: z.number().min(0).max(1),
  verdict: z.enum(['pending', 'correct', 'incorrect']),
  createdAt: IsoSchema,
});
export const ViewShadowResponseSchema = z.object({
  decisions: z.array(ShadowDecisionSchema).max(100),
  stats: RuleStatsSchema,
  activation: ActivationSchema,
});
export const ViewReviewRequestSchema = z.object({ decisionId: IdSchema, verdict: z.enum(['correct', 'incorrect']) });
export const ViewVersionSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().max(120),
  prompt: z.string().max(500),
  filter: FilterSpecSchema,
  actions: z.array(ActionSpecSchema).max(8),
  mode: ViewModeSchema,
  enabled: z.boolean(),
  changedAt: IsoSchema,
  changedBy: z.string().max(120),
});
export const ViewHistoryResponseSchema = z.object({ versions: z.array(ViewVersionSchema).max(200) });

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

export const TRIGGER_KINDS = [
  'email_received',
  'email_sent',
  'reply_received',
  'no_reply_by',
  'tracking_event',
  'state_changed',
  'calendar_approaching',
  'schedule',
  'manual',
] as const;
export const TriggerKindSchema = z.enum(TRIGGER_KINDS);

export const AutonomySchema = z.enum([
  /** Tier 0 only runs; everything else becomes a suggestion in the approval queue. */
  'suggest',
  /** Tier 0–1 run automatically after activation. */
  'auto_reversible',
  /** Tier 0–2 run automatically after activation. */
  'auto_draft',
]);

export const AutomationSchema = z.object({
  id: IdSchema,
  name: z.string().max(120),
  prompt: z.string().max(1_000),
  trigger: z.object({
    kind: TriggerKindSchema,
    /** e.g. { businessDays: 4 } for no_reply_by, { minutesBefore: 30 } for calendar_approaching. */
    params: z.record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean()])).default({}),
  }),
  conditions: FilterSpecSchema,
  context: z.array(z.enum(['thread', 'history', 'calendar', 'contacts', 'documents', 'web'])).max(6),
  actions: z.array(ActionSpecSchema).min(1).max(8),
  autonomy: AutonomySchema,
  schedule: z.object({ cron: z.string().max(64), timeZone: z.string().max(64) }).nullable(),
  mode: z.enum(['shadow', 'active']),
  enabled: z.boolean(),
  version: z.number().int().positive(),
  explanation: z.array(z.string().max(200)).max(20),
  tiers: z.array(z.object({ kind: ActionKindSchema, tier: RiskTierSchema, runsAutomatically: z.boolean() })).max(8),
  stats: z.object({ runs: z.number().int().nonnegative(), lastRunAt: IsoSchema.nullable(), failures: z.number().int().nonnegative() }),
  createdAt: IsoSchema,
  updatedAt: IsoSchema,
});
export type Automation = z.infer<typeof AutomationSchema>;

export const AutomationDraftSchema = AutomationSchema.pick({
  name: true,
  trigger: true,
  conditions: true,
  context: true,
  actions: true,
  autonomy: true,
  schedule: true,
  explanation: true,
  tiers: true,
}).extend({ warnings: z.array(z.string().max(200)).max(8), confidence: z.number().min(0).max(1) });

export const AutomationCompileRequestSchema = z.object({ prompt: z.string().min(3).max(1_000) });
export const AutomationCompileResponseSchema = z.object({ draft: AutomationDraftSchema });
export const AutomationsResponseSchema = z.object({ automations: z.array(AutomationSchema).max(100) });
export const AutomationSaveRequestSchema = z.object({
  id: IdSchema.optional(),
  name: z.string().min(1).max(120),
  prompt: z.string().max(1_000),
  trigger: AutomationSchema.shape.trigger,
  conditions: FilterSpecSchema,
  context: AutomationSchema.shape.context.default(['thread']),
  actions: AutomationSchema.shape.actions,
  autonomy: AutonomySchema.default('suggest'),
  schedule: AutomationSchema.shape.schedule.default(null),
  mode: z.enum(['shadow', 'active']).default('shadow'),
  enabled: z.boolean().default(true),
});
export const AutomationResponseSchema = z.object({ automation: AutomationSchema });
export const AutomationIdRequestSchema = z.object({ id: IdSchema });
export const AutomationRunRequestSchema = z.object({
  id: IdSchema,
  threadId: GmailIdSchema.optional(),
  accountId: IdSchema.optional(),
  idempotencyKey: IdempotencyKeySchema,
});

export const ActionOutcomeSchema = z.enum(['applied', 'shadowed', 'approval_requested', 'skipped', 'failed', 'undone']);
export const AutomationRunSchema = z.object({
  id: IdSchema,
  automationId: IdSchema,
  trigger: TriggerKindSchema,
  threadId: GmailIdSchema.nullable(),
  status: z.enum(['running', 'completed', 'failed', 'skipped']),
  startedAt: IsoSchema,
  completedAt: IsoSchema.nullable(),
  actions: z
    .array(
      z.object({
        kind: ActionKindSchema,
        tier: RiskTierSchema,
        outcome: ActionOutcomeSchema,
        auditId: IdSchema.nullable(),
        approvalId: IdSchema.nullable(),
        detail: z.string().max(200),
      }),
    )
    .max(8),
  errorCode: z.string().max(64).nullable(),
});
export const AutomationRunResponseSchema = z.object({ run: AutomationRunSchema });
export const AutomationRunsRequestSchema = z.object({ id: IdSchema.optional(), limit: z.number().int().min(1).max(100).default(30) });
export const AutomationRunsResponseSchema = z.object({ runs: z.array(AutomationRunSchema).max(100) });

// ---------------------------------------------------------------------------
// Approvals (one queue for Gmail, the side panel and the web app)
// ---------------------------------------------------------------------------

export const ActorTypeSchema = z.enum(['user', 'rule', 'automation', 'follow_up', 'sequence', 'mcp', 'system']);

export const ApprovalSchema = z.object({
  id: IdSchema,
  kind: ActionKindSchema,
  tier: RiskTierSchema,
  status: z.enum(['pending', 'approved', 'rejected', 'expired', 'executed', 'failed']),
  title: z.string().max(200),
  why: z.string().max(500),
  sources: z.array(SourceRefSchema).max(12),
  /** Exactly what would happen. For email: recipients, subject and body as they would be sent. */
  preview: z.object({
    to: z.array(z.string().max(320)).max(100).optional(),
    cc: z.array(z.string().max(320)).max(100).optional(),
    subject: z.string().max(998).optional(),
    body: z.string().max(20_000).optional(),
    event: z
      .object({ title: z.string().max(300), start: IsoSchema, end: IsoSchema, attendees: z.array(z.string().max(320)).max(50) })
      .optional(),
    change: z.string().max(500).optional(),
    count: z.number().int().nonnegative().optional(),
  }),
  responsible: z.object({ type: ActorTypeSchema, id: z.string().max(64).nullable(), name: z.string().max(120) }),
  threadId: GmailIdSchema.nullable(),
  createdAt: IsoSchema,
  expiresAt: IsoSchema.nullable(),
  decidedAt: IsoSchema.nullable(),
  result: z.object({ code: z.string().max(64), message: z.string().max(300) }).nullable(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const ApprovalListRequestSchema = z.object({
  status: z.enum(['pending', 'decided', 'all']).default('pending'),
  limit: z.number().int().min(1).max(100).default(30),
});
export const ApprovalListResponseSchema = z.object({ approvals: z.array(ApprovalSchema).max(100), pending: z.number().int().nonnegative() });
export const ApprovalDecideRequestSchema = z.object({
  id: IdSchema,
  decision: z.enum(['approve', 'reject']),
  /** Edits the user made before approving. The edited content is what executes. */
  edits: z
    .object({ subject: z.string().max(998).optional(), body: z.string().min(1).max(20_000).optional() })
    .optional(),
  idempotencyKey: IdempotencyKeySchema,
});
export const ApprovalResponseSchema = z.object({ approval: ApprovalSchema });

// ---------------------------------------------------------------------------
// Audit and undo
// ---------------------------------------------------------------------------

export const AuditEventSchema = z.object({
  id: IdSchema,
  at: IsoSchema,
  actor: z.object({ type: ActorTypeSchema, id: z.string().max(64).nullable(), name: z.string().max(120) }),
  action: z.string().max(64),
  tier: RiskTierSchema,
  target: z.object({ kind: z.string().max(40), id: z.string().max(256), title: z.string().max(300).nullable() }),
  summary: z.string().max(300),
  policy: z.object({ decision: z.enum(['allowed', 'shadowed', 'approval_required', 'denied']), reason: z.string().max(200) }),
  reversible: z.boolean(),
  undoneAt: IsoSchema.nullable(),
  undoOf: IdSchema.nullable(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const AuditListRequestSchema = z.object({
  threadId: GmailIdSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: CursorSchema.optional(),
});
export const AuditListResponseSchema = z.object({ events: z.array(AuditEventSchema).max(200), nextCursor: CursorSchema.nullable() });
export const UndoRequestSchema = z.object({ auditId: IdSchema, idempotencyKey: IdempotencyKeySchema });
export const UndoResponseSchema = z.object({ event: AuditEventSchema });

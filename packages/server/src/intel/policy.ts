import type { ActionKind, ActionSpec, RiskTier } from '@pigeonbox/api-contract';

/**
 * The autonomy ladder. One policy function decides every action PigeonBox
 * takes or proposes, whoever asks: the user, a Smart View rule, an
 * automation, the follow-up engine, a sequence or an MCP client. There is no
 * privileged path around it.
 *
 *   Tier 0  read-only / internal suggestion       runs automatically
 *   Tier 1  reversible mailbox change             automatic only for an active rule the user enabled; audited, undoable
 *   Tier 2  externally visible draft or state     automatic only when the user enabled it
 *   Tier 3  external side effect (send, invite)   always needs an explicit approval
 */

export type ActorKind = 'user' | 'rule' | 'automation' | 'follow_up' | 'sequence' | 'mcp' | 'system';

export type Autonomy = 'suggest' | 'auto_reversible' | 'auto_draft';

export type PolicyDecision = 'allowed' | 'shadowed' | 'approval_required' | 'denied';

const BASE_TIER: Record<ActionKind, RiskTier> = {
  classify: 0,
  set_state: 0,
  run_analysis: 0,
  create_note: 0,
  notify: 0,
  draft_reply: 0,
  draft_follow_up: 0,
  prepare_event: 0,
  label: 1,
  remove_label: 1,
  archive: 1,
  mark_important: 1,
  star: 1,
  snooze: 1,
  remind: 0,
  create_task: 1,
  create_event: 2,
  send_email: 3,
};

/** The tier of a concrete action; parameters can raise it (placing a draft in Gmail, inviting attendees). */
export function actionTier(spec: Pick<ActionSpec, 'kind' | 'params'>): RiskTier {
  const params = spec.params ?? {};
  if ((spec.kind === 'draft_reply' || spec.kind === 'draft_follow_up') && params.placeInGmail === true) return 2;
  if (spec.kind === 'create_event' && params.notifyAttendees === true) return 3;
  return BASE_TIER[spec.kind];
}

export const ACTION_LABELS: Record<ActionKind, string> = {
  classify: 'Classify',
  set_state: 'Set thread state',
  run_analysis: 'Analyze',
  create_note: 'Add an internal note',
  notify: 'Notify you',
  draft_reply: 'Prepare a reply draft',
  draft_follow_up: 'Prepare a follow-up draft',
  prepare_event: 'Prepare a calendar event',
  label: 'Apply a label',
  remove_label: 'Remove a label',
  archive: 'Archive',
  mark_important: 'Mark important',
  star: 'Star',
  snooze: 'Snooze',
  remind: 'Remind you',
  create_task: 'Create a task',
  create_event: 'Create a calendar event',
  send_email: 'Send an email',
};

export type PolicyInput = {
  tier: RiskTier;
  actor: ActorKind;
  /** The user asked for this specific action just now (a click, or an approved approval). */
  userInitiated: boolean;
  /** An approval for this exact action was granted. */
  approved?: boolean;
  /** For rules and automations. */
  mode?: 'shadow' | 'active' | 'view';
  autonomy?: Autonomy;
  /** For MCP clients: the scopes of the token. */
  scopes?: readonly ('read' | 'prepare' | 'write')[];
  /** The user enabled automatic Gmail drafts in preferences. */
  autoPlaceDrafts?: boolean;
};

export function decide(input: PolicyInput): { decision: PolicyDecision; reason: string } {
  const { tier } = input;
  // Token scopes limit what an MCP client may do on its own. Once the user approves something
  // the client asked for, the approval is the authority (tokens can never approve).
  if (input.actor === 'mcp' && !input.approved) {
    const scopes = new Set(input.scopes ?? []);
    if (tier === 0 && !(scopes.has('read') || scopes.has('prepare') || scopes.has('write'))) return { decision: 'denied', reason: 'The API token has no scopes' };
    if (tier >= 1 && !scopes.has('write')) return { decision: 'denied', reason: 'The API token is not allowed to change mail' };
  }
  if (input.mode === 'shadow' && tier >= 1) return { decision: 'shadowed', reason: 'Shadow Mode: recorded what would happen; nothing changed' };
  if (input.mode === 'shadow' && tier === 0 && input.actor === 'rule') return { decision: 'shadowed', reason: 'Shadow Mode' };
  if (tier === 3) {
    return input.approved
      ? { decision: 'allowed', reason: 'You approved this' }
      : { decision: 'approval_required', reason: 'Sending or inviting always needs your approval' };
  }
  if (tier === 0) return { decision: 'allowed', reason: 'Read-only or internal to PigeonBox' };
  if (input.userInitiated || input.approved) return { decision: 'allowed', reason: 'You asked for this' };
  if (tier === 1) {
    if (input.actor === 'mcp') return { decision: 'allowed', reason: 'Allowed by the API token’s write scope; undoable' };
    const auto = input.autonomy === 'auto_reversible' || input.autonomy === 'auto_draft' || input.actor === 'rule';
    if (input.mode === 'active' && auto) return { decision: 'allowed', reason: 'An active rule you enabled; undoable' };
    return { decision: 'approval_required', reason: 'Mailbox changes need an active rule or your approval' };
  }
  // tier 2
  if (input.actor === 'mcp') return { decision: 'allowed', reason: 'Allowed by the API token’s write scope' };
  if (input.autoPlaceDrafts && (input.actor === 'system' || input.actor === 'follow_up')) return { decision: 'allowed', reason: 'You turned on automatic Gmail drafts' };
  if (input.mode === 'active' && input.autonomy === 'auto_draft') return { decision: 'allowed', reason: 'An active automation allowed to create drafts' };
  return { decision: 'approval_required', reason: 'Creating visible drafts or events needs your approval for this rule' };
}

import { trackProductEvent } from '../../ui/analytics';
/**
 * PigeonBox Cloud in the thread card, shaped by what this email is about:
 *
 *   scheduling  "Scheduling · times from your calendar"; the prepared reply already has them
 *   waiting     "Waiting 4 days · opened 2×"; Follow up
 *   promise     "You promised: send the deck · Fri"
 *   reply       the state and, when there is no reply yet, why it matters
 *   quiet       nothing (done, FYI, notifications)
 *
 * At most one dominant action (Use reply, or Follow up). Sources stay one
 * click away ("Calendar + 2 emails") and open by themselves only when trust
 * needs them: a stale reply, something left to fill in, or injected
 * instructions. Using a reply puts it in Gmail's composer; nothing is sent.
 * Everything is rendered as text.
 */
import type { CloudDraft, SourceRef, ThreadIntel } from '@pigeonbox/api-contract';
import { useEffect, useState } from 'react';
import { CalendarConnectHint, FirstContactNote } from './CloudContext';
import { VARIANT_CHOICE_KEY, rememberVariantChoice } from '../compose/variant-choice';

export type CompanionIntent = 'scheduling' | 'waiting' | 'promise' | 'reply' | 'quiet';

const STATE_LABEL: Record<string, string> = {
  NEEDS_REPLY: 'Needs your reply',
  WAITING_ON_ME: 'Waiting on you',
  WAITING_ON_THEM: 'Waiting on them',
  FOLLOW_UP_DUE: 'Follow-up due',
};

const PLACEHOLDER = /\[(?:[A-Z][A-Z ]+ NEEDED|CONFIRM [A-Z ]+)\]/g;
const IS_PLACEHOLDER = /^\[(?:[A-Z][A-Z ]+ NEEDED|CONFIRM [A-Z ]+)\]$/;
const DAY = 86_400_000;

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso));
}

/** A reply that is still PigeonBox's to offer (not sent or thrown away). */
function liveDraft(intel: ThreadIntel): CloudDraft | null {
  const draft = intel.draft;
  return draft && !['discarded', 'sent', 'failed'].includes(draft.status) ? draft : null;
}

export function companionIntent(intel: ThreadIntel): CompanionIntent {
  const draft = liveDraft(intel);
  if (draft?.kind === 'scheduling' || /schedul|meeting/i.test(intel.state.nextAction.kind)) return 'scheduling';
  const stage = intel.followUp?.stage;
  if (intel.state.state === 'WAITING_ON_THEM' || intel.state.state === 'FOLLOW_UP_DUE' || stage === 'follow_up_due' || ((stage === 'waiting' || stage === 'engaged') && intel.lastMessageFromOwner)) return 'waiting';
  if (intel.commitments.some((item) => item.direction === 'mine' && item.status === 'open')) return 'promise';
  if (draft || intel.state.state === 'NEEDS_REPLY' || intel.state.state === 'WAITING_ON_ME') return 'reply';
  return 'quiet';
}

/** Whether the companion owns the thread's one dominant action, so the card shows no other. */
export function cloudOwnsReply(intel: ThreadIntel | null | undefined): boolean {
  if (!intel) return false;
  const draft = liveDraft(intel);
  if (draft) return true;
  return companionIntent(intel) === 'waiting' && intel.followUp?.stage === 'follow_up_due';
}

/** "Calendar + 2 emails": what a draft relied on, in one short phrase. */
export function sourceSummary(sources: SourceRef[]): string {
  const count = (kinds: string[]) => sources.filter((source) => kinds.includes(source.kind)).length;
  const parts: string[] = [];
  if (count(['calendar_event'])) parts.push('Calendar');
  const plural = (n: number, one: string, many: string) => (n ? [`${n} ${n === 1 ? one : many}`] : []);
  parts.push(
    ...plural(count(['thread', 'message']), 'email', 'emails'),
    ...plural(count(['commitment']), 'promise', 'promises'),
    ...plural(count(['document']), 'file', 'files'),
    ...plural(sources.length - count(['calendar_event', 'thread', 'message', 'commitment', 'document']), 'note', 'notes'),
  );
  return parts.join(' + ') || 'Sources';
}

/**
 * What the calendar gave the scheduling reply, from the availability source's
 * title ("Your availability · 2 open times"). Null when the reply did not use it.
 */
export function schedulingHeadline(sources: SourceRef[]): string | null {
  const source = sources.find((item) => item.kind === 'calendar_event' && /^Your availability\b/.test(item.title));
  if (!source) return sources.some((item) => item.kind === 'calendar_event') ? 'Scheduling · times from your calendar' : null;
  const open = source.title.match(/·\s*(\d+) open times?/);
  if (open) return `Scheduling · ${open[1]} ${open[1] === '1' ? 'time' : 'times'} open`;
  const other = source.title.match(/busy then(?:\s*·\s*(\d+) other times?)?/);
  if (other) return other[1] ? `Scheduling · busy then · ${other[1]} other ${other[1] === '1' ? 'time' : 'times'}` : 'Scheduling · busy then';
  return 'Scheduling · times from your calendar';
}

function waitingLine(intel: ThreadIntel, now: number): string {
  const since = intel.followUp?.lastOutboundAt ?? (intel.lastMessageFromOwner ? intel.lastMessageAt : null);
  const days = since ? Math.floor((now - Date.parse(since)) / DAY) : null;
  const parts = [days === null || Number.isNaN(days) ? 'Waiting on them' : days < 1 ? 'Waiting since today' : `Waiting ${days} day${days === 1 ? '' : 's'}`];
  const opens = intel.followUp?.engagement?.likelyOpens ?? 0;
  if (opens) parts.push(`opened ${opens}×`);
  if (intel.followUp?.stage === 'follow_up_due') parts.push('follow-up due');
  else if (intel.followUp?.dueAt && intel.followUp.stage !== 'reply' && intel.followUp.stage !== 'closed') parts.push(`follow up ${shortDate(intel.followUp.dueAt)}`);
  return parts.join(' · ');
}

/** The draft body with placeholders marked so they stand out. */
function DraftBody({ body, expanded, onToggle }: { body: string; expanded: boolean; onToggle: () => void }) {
  const parts = body.split(/(\[(?:[A-Z][A-Z ]+ NEEDED|CONFIRM [A-Z ]+)\])/g);
  const long = body.split('\n').length > 5 || body.length > 280;
  return (
    <div className="pb-cc-reply" data-expanded={expanded || !long}>
      <p className="gi-cloud-draft">
        {parts.map((part, index) => (IS_PLACEHOLDER.test(part) ? <mark key={index}>{part}</mark> : <span key={index}>{part}</span>))}
      </p>
      {long ? (
        <button type="button" className="gi-text-btn pb-cc-more" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? 'Less' : 'More'}
        </button>
      ) : null}
    </div>
  );
}

export function CloudCompanion(props: {
  intel: ThreadIntel;
  onUseDraft: (body: string) => void;
  /** Ask for a follow-up when one is due and nothing is prepared. */
  onFollowUp?: () => void;
  /** Hand a question to Ask (the long tail: other times, earlier discussion). */
  onAsk?: (question: string) => void;
  capabilities?: string[];
  mailbox?: string;
}) {
  const { intel } = props;
  const capabilities = props.capabilities ?? [];
  const draft = liveDraft(intel);
  const [variantIndex, setVariantIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { if (props.intel.draft) trackProductEvent('first_prepared_draft_seen', { surface: 'gmail', mode: 'cloud' }); }, [props.intel.draft]);
  const intent = companionIntent(intel);
  const offerable = draft && (draft.status === 'ready' || draft.status === 'stale') ? draft : null;
  const variant = offerable?.variants[Math.min(variantIndex, offerable.variants.length - 1)] ?? null;
  const open = [...new Set(variant?.body.match(PLACEHOLDER) ?? [])];
  const mine = intel.commitments.filter((item) => item.direction === 'mine' && item.status === 'open');
  const theirs = intel.commitments.filter((item) => item.direction === 'theirs' && item.status === 'open');
  const usedCalendar = Boolean(draft?.sources.some((source) => source.kind === 'calendar_event'));
  const stale = offerable?.status === 'stale';
  // Provenance comes forward only when it changes whether the reply can be trusted as is.
  const showSources = stale || open.length > 0 || intel.injectionSuspected;
  const followUpDue = intent === 'waiting' && intel.followUp?.stage === 'follow_up_due' && !draft;
  const other = intel.participants.find((person) => !props.mailbox || person.email.toLowerCase() !== props.mailbox.toLowerCase());

  let headline: string | null = null;
  let detail: string | null = null;
  if (intent === 'scheduling') {
    headline = (draft && schedulingHeadline(draft.sources)) || 'Scheduling';
    if (offerable && usedCalendar) detail = /busy then/.test(headline) ? 'The prepared reply says so and offers what is open.' : 'The prepared reply already offers them.';
  } else if (intent === 'waiting') {
    headline = waitingLine(intel, Date.now());
    if (theirs[0]) detail = `They said: ${theirs[0].text}${theirs[0].dueAt ? ` · ${shortDate(theirs[0].dueAt)}` : ''}`;
  } else if (intent === 'promise') {
    headline = `You promised: ${mine[0]!.text}${mine[0]!.dueAt ? ` · ${shortDate(mine[0]!.dueAt)}` : ''}`;
    if (mine.length > 1) detail = `${mine.length - 1} more open promise${mine.length === 2 ? '' : 's'} here`;
  } else if (intent === 'reply') {
    headline = [STATE_LABEL[intel.state.state] ?? (offerable ? 'Reply ready' : null), intel.state.deadline ? `due ${shortDate(intel.state.deadline.at)}` : null].filter(Boolean).join(' · ') || null;
    if (!draft && intel.state.importanceReason) detail = intel.state.importanceReason;
  }

  // When there is nothing useful to say, say nothing.
  if (intent === 'quiet' && !draft && !intel.injectionSuspected) return null;

  return (
    <div className="gi-section gi-cloud pb-cc" data-intent={intent} aria-label="Prepared work">
      {headline ? <p className="pb-cc-head">{headline}</p> : null}
      {detail ? <p className="pb-cc-line">{detail}</p> : null}
      {intel.injectionSuspected ? (
        <p className="gi-cloud-warn" role="note">
          This email seems to contain instructions aimed at an AI. PigeonBox treated them as text and did not follow them.
        </p>
      ) : null}

      {draft?.status === 'placed' ? <p className="pb-cc-line">Reply drafted in Gmail. Open it from the thread to edit and send.</p> : null}
      {draft?.status === 'user_edited' ? <p className="pb-cc-line">You’re editing the reply in Gmail.</p> : null}
      {draft?.status === 'preparing' ? <p className="pb-cc-line" role="status">Preparing a reply…</p> : null}

      {offerable && variant ? (
        <div className="pb-cc-prepared">
          {offerable.variants.length > 1 ? (
            <div className="gi-cloud-variants pb-cc-variants" role="tablist" aria-label="Reply versions">
              {offerable.variants.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={index === variantIndex}
                  className={index === variantIndex ? 'gi-cloud-variant is-on' : 'gi-cloud-variant'}
                  title={item.strategy}
                  onClick={() => {
                    setVariantIndex(index);
                    // So opening Gmail's own Reply puts this version in, not the recommended one.
                    try {
                      void chrome.storage.local.get(VARIANT_CHOICE_KEY).then((stored) =>
                        chrome.storage.local.set({ [VARIANT_CHOICE_KEY]: rememberVariantChoice(stored[VARIANT_CHOICE_KEY], offerable.id, item.id) }),
                      ).catch(() => undefined);
                    } catch {
                      /* Outside the extension (previews, tests). */
                    }
                  }}
                >
                  {item.label === 'recommended' ? 'Recommended' : item.label === 'shorter' ? 'Shorter' : 'Alternative'}
                </button>
              ))}
            </div>
          ) : null}
          {stale ? <p className="gi-cloud-warn">{offerable.freshness.staleReason ?? 'The thread changed since this reply was prepared.'}</p> : null}
          <DraftBody body={variant.body} expanded={expanded} onToggle={() => setExpanded((value) => !value)} />
          {open.length ? <p className="gi-cloud-warn">Fill in {open.join(', ')} before sending.</p> : null}
          <div className="gi-actions pb-cc-actions">
            <button type="button" className="gi-action" onClick={() => { trackProductEvent('prepared_draft_used', { surface: 'gmail', mode: 'cloud' }); props.onUseDraft(variant.body); }}>
              {offerable.kind === 'follow_up' ? 'Use follow-up' : 'Use reply'}
            </button>
            {offerable.sources.length ? (
              <details className="pb-cc-sources" open={showSources}>
                <summary>{sourceSummary(offerable.sources)}</summary>
                <ul className="gi-points">
                  {offerable.sources.map((source) => (
                    <li key={source.id}>
                      {source.gmailThreadId ? (
                        <a className="gi-link" target="_blank" rel="noreferrer" href={`https://mail.google.com/mail/?authuser=${encodeURIComponent(props.mailbox || '0')}#all/${encodeURIComponent(source.gmailThreadId)}`}>{source.title}</a>
                      ) : (
                        <span>{source.title}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        </div>
      ) : null}

      {followUpDue && props.onFollowUp ? (
        <div className="gi-actions pb-cc-actions">
          <button type="button" className="gi-action" onClick={props.onFollowUp}>Follow up</button>
        </div>
      ) : null}

      {intent === 'scheduling' && capabilities.includes('cloud_calendar') ? (
        <div className="pb-cc-secondary-row">
          {!usedCalendar ? <CalendarConnectHint intel={intel} mailbox={props.mailbox} /> : null}
          {props.onAsk ? (
            <button type="button" className="gi-text-btn pb-cc-secondary" onClick={() => props.onAsk!('When am I free over the next few days?')}>
              Change times
            </button>
          ) : null}
        </div>
      ) : null}

      {intel.state.relationshipImportance === 'new' && capabilities.includes('cloud_relationships') && other && intent !== 'quiet' ? (
        <FirstContactNote intel={intel} mailbox={props.mailbox} name={other.name || other.email} />
      ) : null}
    </div>
  );
}

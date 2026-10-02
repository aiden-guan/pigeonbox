import { trackProductEvent } from '../../ui/analytics';
/**
 * PigeonBox Cloud sections of the thread card: what the always-on service
 * knows about this thread (state, next action, deadline, promises, follow-up)
 * and the draft it prepared, with its sources and anything left to fill in.
 * Read-only: using a draft puts it in Gmail's composer for the person to edit
 * and send. Everything is rendered as text.
 */
import type { ThreadIntel } from '@pigeonbox/api-contract';
import { useEffect, useState } from 'react';
import { CloudContext } from './CloudContext';

const STATE_LABEL: Record<string, string> = {
  NEEDS_REPLY: 'Needs your reply',
  WAITING_ON_ME: 'Waiting on you',
  WAITING_ON_THEM: 'Waiting on them',
  FOLLOW_UP_DUE: 'Follow-up due',
  FYI: 'For your information',
  SCHEDULED: 'Scheduled',
  DONE: 'Done',
  NOTIFICATION: 'Notification',
  PROMOTION: 'Promotion',
  NEWS: 'News',
};

const STAGE_LABEL: Record<string, string> = {
  sent: 'Sent',
  waiting: 'Waiting for a reply',
  engaged: 'Waiting · recent activity',
  reply: 'They replied',
  follow_up_due: 'Follow-up due',
  closed: 'Closed',
};

const PLACEHOLDER = /\[(?:[A-Z][A-Z ]+ NEEDED|CONFIRM [A-Z ]+)\]/g;
const IS_PLACEHOLDER = /^\[(?:[A-Z][A-Z ]+ NEEDED|CONFIRM [A-Z ]+)\]$/;

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso));
}

/** The draft body with placeholders marked so they stand out. */
function DraftBody({ body }: { body: string }) {
  const parts = body.split(/(\[(?:[A-Z][A-Z ]+ NEEDED|CONFIRM [A-Z ]+)\])/g);
  return (
    <p className="gi-cloud-draft">
      {parts.map((part, index) => (IS_PLACEHOLDER.test(part) ? <mark key={index}>{part}</mark> : <span key={index}>{part}</span>))}
    </p>
  );
}

export function CloudCompanion(props: { intel: ThreadIntel; onUseDraft: (body: string) => void; capabilities?: string[]; mailbox?: string }) {
  const { intel } = props;
  const draft = intel.draft && intel.draft.status !== 'discarded' && intel.draft.status !== 'sent' ? intel.draft : null;
  const [variantIndex, setVariantIndex] = useState(0);
  useEffect(() => { if (props.intel.draft) trackProductEvent('first_prepared_draft_seen', { surface: 'gmail', mode: 'cloud' }); }, [props.intel.draft]);
  const variant = draft?.variants[Math.min(variantIndex, (draft?.variants.length ?? 1) - 1)] ?? null;
  const open = [...new Set(variant?.body.match(PLACEHOLDER) ?? [])];
  const mine = intel.commitments.filter((item) => item.direction === 'mine' && item.status === 'open');
  const theirs = intel.commitments.filter((item) => item.direction === 'theirs' && item.status === 'open');
  const state = intel.state;

  return (
    <div className="gi-section gi-cloud" aria-label="Prepared work">
      <div className="gi-cloud-state">
        <strong>{STATE_LABEL[state.state] ?? state.state}</strong>
      </div>
      {state.importanceReason ? <p className="gi-cloud-why">{state.importanceReason}</p> : null}
      {state.nextAction.label ? <div className="gi-cloud-next"><strong>{state.nextAction.label}</strong></div> : null}
      {state.deadline ? <span className="gi-date">Due {shortDate(state.deadline.at)}</span> : null}
      {intel.injectionSuspected ? (
        <p className="gi-cloud-warn" role="note">
          This email seems to contain instructions aimed at an AI. PigeonBox treated them as text and did not follow them.
        </p>
      ) : null}

      {mine.length || theirs.length ? (
        <>
          <div className="gi-section-heading">Commitments</div>
          <ul className="gi-points">
            {mine.map((item) => (
              <li key={item.id}>
                <strong>You promised</strong>: {item.text}
                {item.dueAt ? ` · ${shortDate(item.dueAt)}` : ''}
              </li>
            ))}
            {theirs.map((item) => (
              <li key={item.id}>
                <strong>They promised</strong>: {item.text}
                {item.dueAt ? ` · ${shortDate(item.dueAt)}` : ''}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {intel.followUp ? (
        <>
          <div className="gi-section-heading">Follow-up</div>
          <p className="gi-cloud-why">
            {STAGE_LABEL[intel.followUp.stage] ?? intel.followUp.stage}
            {intel.followUp.dueAt && intel.followUp.stage !== 'reply' && intel.followUp.stage !== 'closed' ? ` · due ${shortDate(intel.followUp.dueAt)}` : ''}
            {intel.followUp.engagement?.likelyOpens ? ` · ${intel.followUp.engagement.likelyOpens} likely open${intel.followUp.engagement.likelyOpens === 1 ? '' : 's'}` : ''}
          </p>
        </>
      ) : null}

      <CloudContext intel={intel} capabilities={props.capabilities ?? []} mailbox={props.mailbox} onInsert={props.onUseDraft} />
      {draft && variant ? (
        <>
          <p className="gi-cloud-why">Reply prepared</p>
          {draft.variants.length > 1 ? (
            <div className="gi-cloud-variants" role="tablist" aria-label="Draft options">
              {draft.variants.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={index === variantIndex}
                  className={index === variantIndex ? 'gi-cloud-variant is-on' : 'gi-cloud-variant'}
                  title={item.strategy}
                  onClick={() => setVariantIndex(index)}
                >
                  {item.label === 'recommended' ? 'Recommended' : item.label === 'shorter' ? 'Shorter' : 'Alternative'}
                </button>
              ))}
            </div>
          ) : null}
          {draft.status === 'stale' ? <p className="gi-cloud-warn">{draft.freshness.staleReason ?? 'The thread changed since this draft was prepared.'}</p> : null}
          <DraftBody body={variant.body} />
          {open.length ? <p className="gi-cloud-warn">Fill in {open.join(', ')} before sending.</p> : null}
          {draft.sources.length ? <details className="gi-cloud-context"><summary>Used to prepare this draft</summary><ul className="gi-points">{draft.sources.map((source) => <li key={source.id}>{source.gmailThreadId ? <a className="gi-link" target="_blank" rel="noreferrer" href={`https://mail.google.com/mail/?authuser=${encodeURIComponent(props.mailbox || '0')}#all/${encodeURIComponent(source.gmailThreadId)}`}>{source.title}</a> : <span>{source.title}</span>}</li>)}</ul></details> : null}
          <div className="gi-actions">
            <button type="button" className="gi-action" onClick={() => { trackProductEvent('prepared_draft_used', { surface: 'gmail', mode: 'cloud' }); props.onUseDraft(variant.body); }}>
              Use prepared reply
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * PigeonBox Cloud sections of the thread card: what the always-on service
 * knows about this thread (state, next action, deadline, promises, follow-up)
 * and the draft it prepared, with its sources and anything left to fill in.
 * Read-only: using a draft puts it in Gmail's composer for the person to edit
 * and send. Everything is rendered as text.
 */
import type { ThreadIntel } from '@pigeonbox/api-contract';
import { useState } from 'react';

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

export function CloudCompanion(props: { intel: ThreadIntel; onUseDraft: (body: string) => void }) {
  const { intel } = props;
  const draft = intel.draft && intel.draft.status !== 'discarded' && intel.draft.status !== 'sent' ? intel.draft : null;
  const [variantIndex, setVariantIndex] = useState(0);
  const variant = draft?.variants[Math.min(variantIndex, (draft?.variants.length ?? 1) - 1)] ?? null;
  const open = [...new Set(variant?.body.match(PLACEHOLDER) ?? [])];
  const mine = intel.commitments.filter((item) => item.direction === 'mine' && item.status === 'open');
  const theirs = intel.commitments.filter((item) => item.direction === 'theirs' && item.status === 'open');
  const state = intel.state;

  return (
    <div className="gi-section gi-cloud" aria-label="PigeonBox Cloud">
      <div className="gi-section-heading">Cloud</div>
      <div className="gi-cloud-state">
        <strong>{STATE_LABEL[state.state] ?? state.state}</strong>
        {state.nextAction.label ? <span>{state.nextAction.label}</span> : null}
      </div>
      {state.importanceReason ? <p className="gi-cloud-why">{state.importanceReason}</p> : null}
      {state.deadline ? <span className="gi-date">Due {shortDate(state.deadline.at)}</span> : null}
      {intel.injectionSuspected ? (
        <p className="gi-cloud-warn" role="note">
          This email seems to contain instructions aimed at an AI. PigeonBox treated them as text and did not follow them.
        </p>
      ) : null}

      {mine.length || theirs.length ? (
        <>
          <div className="gi-section-heading">Promises</div>
          <ul className="gi-points">
            {mine.map((item) => (
              <li key={item.id}>
                You: {item.text}
                {item.dueAt ? ` · ${shortDate(item.dueAt)}` : ''}
              </li>
            ))}
            {theirs.map((item) => (
              <li key={item.id}>
                {item.owner}: {item.text}
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

      {draft && variant ? (
        <>
          <div className="gi-section-heading">Prepared draft</div>
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
          {draft.sources.length ? (
            <p className="gi-cloud-sources">
              Used to prepare this draft: {draft.sources.slice(0, 4).map((source) => source.title).join(' · ')}
            </p>
          ) : null}
          <div className="gi-actions">
            <button type="button" className="gi-action" onClick={() => props.onUseDraft(variant.body)}>
              Use this draft
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

import { useTransfer } from '../ui/continuity';
import type { CloudDraft, ThreadIntel } from '@pigeonbox/api-contract';
import { useEffect, useMemo, useRef, useState } from 'react';
import { trackProductEvent } from '../ui/analytics';
import { Orb } from '../ui/Orb';
import { callCloud } from './cloud-api';
import { ago, draftKindLabel, draftStateLabel, openPlaceholders, personLabel, placementLine } from './cloud-presenters';
import { useWorkspaceInput } from '../workspace/session';
import { SourceChips } from './SourceChips';

export type ReviewTarget = {
  threadId: string;
  accountId: string;
  /** Rendered immediately when the list already has it; thread context still loads. */
  draft?: CloudDraft;
  subject?: string;
  person?: { email: string; name?: string } | null;
  /** Display name from the Focus Queue, when there is no structured person. */
  who?: string;
  from: 'home' | 'drafts';
};

const VARIANT_LABEL = { recommended: 'Recommended', shorter: 'Shorter', alternative: 'Alternative' } as const;
const newKey = () => crypto.randomUUID();

/**
 * One prepared draft, with the conversation it answers. Uses the existing
 * draft routes only: `draftPlace` adds or updates the Gmail draft,
 * `draftPrepare` updates or regenerates it, `draftFeedback` dismisses it.
 * Nothing here sends mail.
 */
export function DraftReview(props: { target: ReviewTarget; onBack: () => void; onOpenThread: (id: string, accountId?: string) => void; onChanged: () => void }) {
  const { target } = props;
  const transfer = useTransfer<HTMLElement>(`draft:${target.threadId}`);
  const [intel, setIntel] = useState<ThreadIntel | null>(null);
  const [contextError, setContextError] = useState('');
  const [draft, setDraft] = useState<CloudDraft | null>(target.draft ?? null);
  const [variantId, setVariantId] = useState<string | null>(target.draft?.placedVariantId ?? target.draft?.variants[0]?.id ?? null);
  const [body, setBody] = useState(() => (target.draft?.variants.find((item) => item.id === (target.draft?.placedVariantId ?? target.draft?.variants[0]?.id)) ?? target.draft?.variants[0])?.body ?? '');
  const [checkpoint, setCheckpoint, checkpointReady] = useWorkspaceInput<{ draftId: string; variantId: string; body: string } | null>(`draft:${target.accountId}:${target.threadId}`, null);
  const [busy, setBusy] = useState<'' | 'place' | 'prepare' | 'regenerate' | 'dismiss'>('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  /** The text this session put in Gmail, which can differ from the prepared variant. */
  const [placedText, setPlacedText] = useState<string | null>(null);
  const placeKey = useRef(newKey());
  const editor = useRef<HTMLTextAreaElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    let live = true;
    void callCloud('threadsIntel', { accountId: target.accountId, threadIds: [target.threadId] }).then((result) => {
      if (!live) return;
      if (!result.ok) return setContextError(result.reason);
      const found = result.data.threads[target.threadId] ?? null;
      setIntel(found);
      // Opened from Home: the thread's live draft is the one to review.
      if (!target.draft && found?.draft) adopt(found.draft);
      if (!target.draft && !found?.draft) setContextError('This draft is no longer available. It may have been sent or dismissed.');
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.accountId, target.threadId]);

  function adopt(next: CloudDraft, keepText = false) {
    setDraft(next);
    if (!keepText) setPlacedText(null);
    const chosen = next.variants.find((item) => item.id === (keepText ? variantId : next.placedVariantId)) ?? next.variants[0];
    if (!keepText || !chosen || chosen.id !== variantId) {
      setVariantId(chosen?.id ?? null);
      setBody(chosen?.body ?? '');
    }
    placeKey.current = newKey();
  }

  useEffect(() => {
    if (!checkpointReady || !checkpoint || !draft || checkpoint.draftId !== draft.id || !draft.variants.some((variant) => variant.id === checkpoint.variantId)) return;
    setVariantId(checkpoint.variantId); setBody(checkpoint.body);
  }, [checkpoint, checkpointReady, draft]);

  const variant = draft?.variants.find((item) => item.id === variantId) ?? draft?.variants[0] ?? null;
  const edited = Boolean(variant && body.trim() !== variant.body.trim());
  const open = useMemo(() => openPlaceholders(body), [body]);
  const subject = target.subject ?? intel?.subject ?? '';
  const person = target.person ?? intel?.participants.find((item) => item.email) ?? null;
  const inGmail = Boolean(draft?.gmailDraftId);
  const gmailCurrent = draft?.status === 'placed' && variant?.id === draft.placedVariantId && body.trim() === (placedText ?? variant?.body ?? '').trim();

  function chooseVariant(id: string) {
    const next = draft?.variants.find((item) => item.id === id);
    if (!next) return;
    setVariantId(id);
    setBody(next.body);
    setCheckpoint(draft ? { draftId: draft.id, variantId: id, body: next.body } : null);
    placeKey.current = newKey();
  }

  function selectPlaceholder(token: string) {
    const area = editor.current;
    if (!area) return;
    const index = area.value.indexOf(token);
    if (index < 0) return;
    area.focus();
    area.setSelectionRange(index, index + token.length);
  }

  async function place() {
    if (!draft || !variant || open.length) return;
    setBusy('place'); setError(''); setNotice('');
    const result = await callCloud('draftPlace', { draftId: draft.id, variantId: variant.id, idempotencyKey: placeKey.current, ...(edited ? { body: body.trim() } : {}) });
    setBusy('');
    if (!result.ok) return setError(result.code === 'forbidden' ? `${result.reason} You can turn it on in connection settings.` : result.reason);
    if (result.data.draft) adopt(result.data.draft, true);
    setPlacedText(body.trim());
    setCheckpoint(null);
    trackProductEvent('prepared_draft_used', { surface: 'sidepanel', mode: 'cloud' });
    setNotice(inGmail ? 'Gmail draft updated. Nothing was sent.' : 'Added to your Gmail Drafts. Nothing was sent.');
    props.onChanged();
  }

  async function prepare(force: boolean) {
    if (!draft) return;
    setBusy(force ? 'regenerate' : 'prepare'); setError(''); setNotice('');
    const result = await callCloud('draftPrepare', { accountId: draft.accountId, threadId: draft.threadId, kind: draft.kind, ...(force ? { force: true } : {}) });
    setBusy('');
    if (!result.ok) return setError(`This reply could not be prepared. ${result.reason}`);
    if (!result.data.draft) return setError('This reply could not be prepared.');
    setCheckpoint(null); adopt(result.data.draft);
    setNotice(result.data.draft.status === 'user_edited' ? 'You edited this draft in Gmail, so PigeonBox left it alone.' : 'Draft updated from the latest messages.');
    props.onChanged();
  }

  async function dismiss() {
    if (!draft) return;
    if (!confirmDismiss) return setConfirmDismiss(true);
    setBusy('dismiss'); setError('');
    const result = await callCloud('draftFeedback', { draftId: draft.id, ...(variant ? { variantId: variant.id } : {}), outcome: 'discarded' });
    setBusy('');
    if (!result.ok) return setError(result.reason);
    props.onChanged();
    setCheckpoint(null); props.onBack();
  }

  const status = draft?.status;
  const primary: { label: string; run: () => void; disabled?: boolean } | null = !draft
    ? null
    : status === 'user_edited'
      ? { label: 'Open in Gmail', run: () => props.onOpenThread(draft.threadId, draft.accountId) }
      : status === 'stale' || status === 'failed'
        ? { label: busy === 'prepare' ? 'Preparing draft…' : 'Update draft', run: () => void prepare(false), disabled: Boolean(busy) }
        : status === 'preparing'
          ? null
          : gmailCurrent
            ? { label: 'Open in Gmail', run: () => props.onOpenThread(draft.threadId, draft.accountId) }
            : { label: busy === 'place' ? (inGmail ? 'Updating Gmail…' : 'Adding to Gmail…') : inGmail ? 'Update Gmail draft' : 'Add to Gmail', run: () => void place(), disabled: Boolean(busy) || open.length > 0 || !variant };

  return (
    <article ref={transfer} className="pb-review" aria-labelledby="pb-review-title">
      <button type="button" className="pb-back" onClick={props.onBack}>← {target.from === 'drafts' ? 'Drafts' : 'Home'}</button>
      <header className="pb-review-head">
        <span className="pb-meta">{[draftKindLabel(draft?.kind ?? 'reply') ?? 'Reply', draft ? (draft.status === 'preparing' ? 'Preparing now' : `Prepared ${ago(draft.freshness.createdAt)}`) : null].filter(Boolean).join(' · ')}</span>
        <h2 id="pb-review-title" ref={heading} tabIndex={-1} data-continuity="sender">{target.who ?? personLabel(person, subject || 'Prepared reply')}</h2>
        {subject ? <p className="pb-review-subject" data-continuity="subject">{subject}</p> : null}
        {draft ? <span className="pb-state" data-status={draft.status}>{draftStateLabel(draft)}</span> : null}
      </header>

      <section className="pb-review-context" aria-label="Conversation">
        {intel?.summary ? (
          <>
            <p className="pb-review-summary">{intel.summary.oneLine}</p>
            {intel.summary.keyPoints.length ? <ul>{intel.summary.keyPoints.slice(0, 3).map((point) => <li key={point}>{point}</li>)}</ul> : null}
          </>
        ) : intel ? (
          <p className="pb-quiet">Last message {ago(intel.lastMessageAt)}.</p>
        ) : contextError ? (
          <p className="gi-warn" role="alert">{draft ? 'The conversation summary could not load. The draft below is still current as shown.' : contextError}</p>
        ) : (
          <p className="gi-orb-line gi-muted" role="status"><Orb size={14} />Loading the conversation…</p>
        )}
        {intel?.state.deadline ? <span className="pb-flag" data-urgent={Date.parse(intel.state.deadline.at) < Date.now()}>{Date.parse(intel.state.deadline.at) < Date.now() ? 'Deadline passed' : `Due ${new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(intel.state.deadline.at))}`}</span> : null}
      </section>

      {draft ? (
        <section className="pb-review-draft" aria-label="Prepared draft">
          <p className="pb-placement" data-status={draft.status} role="status">{placementLine(draft)}</p>
          {draft.variants.length > 1 ? (
            <div className="pb-variants" role="group" aria-label="Draft options">
              {draft.variants.map((item) => (
                <button key={item.id} type="button" aria-pressed={item.id === variant?.id} className="pb-variant" onClick={() => chooseVariant(item.id)} disabled={status === 'user_edited'}>
                  <strong>{VARIANT_LABEL[item.label]}</strong>
                  <span>{item.strategy}</span>
                </button>
              ))}
            </div>
          ) : null}
          {variant ? (
            <>
              <label className="pb-editor-label" htmlFor="pb-draft-body">Draft{edited ? ' · edited' : ''}</label>
              <textarea
                id="pb-draft-body"
                ref={editor}
                className="gi-field pb-editor"
                value={body}
                readOnly={status === 'user_edited' || status === 'preparing'}
                rows={Math.min(14, Math.max(6, body.split('\n').length + 1))}
                aria-describedby={open.length ? 'pb-placeholders' : undefined}
                onChange={(event) => { setBody(event.target.value); if (draft && variant) setCheckpoint({ draftId: draft.id, variantId: variant.id, body: event.target.value }); placeKey.current = newKey(); }}
              />
              {open.length ? (
                <div id="pb-placeholders" className="pb-placeholders">
                  <span>Fill in before adding to Gmail:</span>
                  {open.map((token) => <button key={token} type="button" className="pb-token" onClick={() => selectPlaceholder(token)}>{token}</button>)}
                </div>
              ) : null}
            </>
          ) : status === 'preparing' ? (
            <p className="gi-orb-line gi-muted" role="status"><Orb size={14} />Preparing draft…</p>
          ) : null}
          {draft.sources.length ? (
            <div className="pb-review-sources">
              <span className="pb-meta">Used to prepare this draft</span>
              <SourceChips sources={draft.sources} onOpenThread={props.onOpenThread} />
            </div>
          ) : null}
        </section>
      ) : null}

      {notice ? <p className="gi-note" role="status">{notice}</p> : null}
      {error ? <p className="gi-warn" role="alert">{error}</p> : null}

      {draft ? (
        <div className="pb-review-actions">
          {primary ? <button type="button" className="gi-btn" disabled={primary.disabled} onClick={primary.run}>{primary.label}</button> : null}
          <button type="button" className="gi-btn gi-btn-ghost" onClick={() => props.onOpenThread(draft.threadId, draft.accountId)}>Open thread</button>
          {status !== 'user_edited' && status !== 'preparing' && status !== 'failed' ? (
            <button type="button" className="gi-text-btn" disabled={Boolean(busy)} onClick={() => void prepare(true)}>{busy === 'regenerate' ? 'Preparing draft…' : 'Regenerate'}</button>
          ) : null}
          {!inGmail && status !== 'user_edited' ? (
            <button type="button" className="gi-text-btn pb-danger-text" disabled={Boolean(busy)} onClick={() => void dismiss()} onBlur={() => setConfirmDismiss(false)}>{confirmDismiss ? 'Confirm dismiss' : 'Dismiss'}</button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

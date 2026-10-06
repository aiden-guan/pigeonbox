import { useEffect, useState, useRef } from 'react';
import type { ThreadIntel } from '@pigeonbox/api-contract';
import { describeTrackingStatus, normalizeGmailId, type TrackedEmailSummary } from '@pigeonbox/tracking';
import { rememberTransfer } from '../ui/continuity';
import { ThreadPanel, type LocalThreadIntel } from '../content/thread/ThreadPanel';
import { useProductState } from '../ui/product-state';
import type { WorkspaceContext } from './context';
import { Tasks } from './Tasks';

export function CurrentThread({ context, onAsk }: { context: WorkspaceContext | null; onAsk: (question: string) => void }) {
  const ref = useRef<HTMLElement>(null);
  const [intel, setIntel] = useState<LocalThreadIntel>();
  const [cloud, setCloud] = useState<ThreadIntel | null>(null);
  const [tracked, setTracked] = useState<TrackedEmailSummary | null>(null);
  const [error, setError] = useState('');
  const product = useProductState();
  const contextRef = context;
  const canSync = product.has('cloud_mail_sync');
  const cloudOrigin = product.state.cloudOrigins.join('|');
  useEffect(() => {
    const context = contextRef;
    let active = true;
    setIntel(undefined); setCloud(null); setTracked(null); setError('');
    if (!context) return;
    const update = () => {
      void chrome.runtime.sendMessage({ type: 'GET_THREAD_INTEL', threadId: context.threadId, owner: context.owner }).then((value) => { if (active) setIntel(value); });
      void chrome.runtime.sendMessage({ type: 'GET_TRACKED_EMAILS' }).then((value) => { if (active) setTracked((value?.emails || []).filter((email: TrackedEmailSummary) => normalizeGmailId(email.gmailThreadId) === normalizeGmailId(context.threadId)).sort((a: TrackedEmailSummary, b: TrackedEmailSummary) => (Date.parse(b.sentAt || '') || 0) - (Date.parse(a.sentAt || '') || 0))[0] || null); });
      if (canSync && context.owner) void chrome.runtime.sendMessage({ type: 'CLOUD_THREAD_INTEL', threadIds: [context.threadId], mailbox: context.owner.email }).then((value) => { if (active) setCloud(value?.threads?.[context.threadId] || null); });
    };
    update();
    const change = (changes: Record<string, chrome.storage.StorageChange>) => { if (changes.intelPulse || changes.trackedEmails) update(); };
    chrome.storage.onChanged.addListener(change);
    return () => { active = false; chrome.storage.onChanged.removeListener(change); };
  }, [contextRef, cloudOrigin, canSync]);
  if (!context) return null;
  const displayIntel: LocalThreadIntel | undefined = cloud?.summary && context.owner ? { ...intel, summary: { source: 'model', aiStatus: 'success', summary: cloud.summary } } : intel;
  const badge = tracked ? describeTrackingStatus(tracked) : null;
  const action = async (id: string, body?: string) => {
    setError('');
    const result = await chrome.runtime.sendMessage({ type: 'WORKSPACE_THREAD_ACTION', threadId: context.threadId, id, body });
    if (result?.ok === false || result?.success === false) setError(result.reason || 'This action could not finish.');
  };
  return <section ref={ref} className="pb-current-thread" aria-label="Current conversation" key={`${context.threadId}:${context.owner?.email || 'resolving'}`}>
    <div className="pb-current-heading"><span data-continuity="sender">{context.sender || 'Current conversation'}</span><h1 data-continuity="subject">{context.subject || '(no subject)'}</h1></div>
    <ThreadPanel intel={displayIntel} pending={!context.owner ? 'Resolving Gmail account…' : cloud?.summary ? null : context.pending} canDraft drafting={context.drafting}
      tracking={badge ? { opened: Boolean(tracked?.openCount), markLabel: badge.markLabel, headline: badge.headline, detail: badge.detail, countLabel: badge.countLabel, sentAt: tracked?.sentAt, firstOpenedAt: tracked?.firstOpenedAt } : null}
      onDraft={() => void action('draft')} onRemind={() => void action('remind')} onRetrySummary={() => void action('summarize')}
      cloud={cloud} cloudCapabilities={product.state.capabilities} mailbox={context.owner?.email} onUseCloudDraft={(body) => void action('use-draft', body)} onAsk={(question) => { if (ref.current) rememberTransfer(ref.current, `context:${context.threadId}`); onAsk(question); }} />
    {error ? <p className="gi-danger" role="alert">{error}</p> : null}
    <button type="button" className="gi-text-btn pb-thread-ask" onClick={() => { if (ref.current) rememberTransfer(ref.current, `context:${context.threadId}`); onAsk('What do I need to do in this thread?'); }}>Ask about this thread ↗</button>
    <Tasks key={`${product.state.cloud.email}:${context.threadId}`} enabled={product.state.runMode === 'cloud' && canSync} context={context} suggestions={[...(intel?.summary?.summary?.actionItems || []), ...(cloud?.commitments.filter((item) => item.direction === 'mine' && item.status === 'open').map((item) => item.text) || []), ...(cloud?.followUp?.stage === 'follow_up_due' ? [`Follow up: ${context.subject || 'this conversation'}`] : [])]} dueDates={Object.fromEntries([...(cloud?.commitments.filter((item) => item.direction === 'mine' && item.status === 'open' && item.dueAt).map((item) => [item.text, item.dueAt!]) || []), ...(cloud?.followUp?.dueAt ? [[`Follow up: ${context.subject || 'this conversation'}`, cloud.followUp.dueAt]] : [])])} />
  </section>;
}

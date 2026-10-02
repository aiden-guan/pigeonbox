import { describeTrackingStatus, normalizeGmailId, type TrackedEmailSummary } from '@pigeonbox/tracking';
import { callCloud } from '../sidepanel/cloud-api';
import type { WorkspaceContext } from './context';

/** Explicit current-conversation actions use the same intelligence, tracking and task stores as Home. */
export async function answerThreadQuestion(question: string, context: WorkspaceContext | null, canSaveTasks: boolean): Promise<string | null> {
  if (!context) return null;
  const input = question.trim().replace(/[?.!]+$/, '').toLowerCase();
  if (/^(?:draft (?:a )?reply|reply to (?:this|this email|this thread))$/.test(input)) {
    const result = await chrome.runtime.sendMessage({ type: 'WORKSPACE_THREAD_ACTION', id: 'draft', threadId: context.threadId });
    return result?.ok === false ? result.reason || 'Could not prepare this reply.' : 'Preparing a reply for this conversation in Gmail. Nothing is sent.';
  }
  if (/^(?:did they open this|was this (?:email )?opened)$/.test(input)) {
    const result = await chrome.runtime.sendMessage({ type: 'GET_TRACKED_EMAILS' });
    const emails = (result?.emails || []) as TrackedEmailSummary[];
    const email = emails.filter((row) => normalizeGmailId(row.gmailThreadId) === normalizeGmailId(context.threadId)).sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || ''))[0];
    if (!email) return 'This conversation has no tracked sent message on this computer.';
    const status = describeTrackingStatus(email);
    return [status.headline, status.detail].filter(Boolean).join(' ');
  }
  const task = /^(?:add this to my tasks|save (?:this )?(?:as a )?task)$/.test(input);
  if (!task) return null;
  if (!canSaveTasks) return 'Saving tasks requires mailbox sync. You can set a reminder for this conversation from Home.';
  if (!context.owner) return 'Resolving your Gmail account. Try again when this conversation is ready.';
  const intel = await chrome.runtime.sendMessage({ type: 'GET_THREAD_INTEL', threadId: context.threadId, owner: context.owner });
  const title = (intel?.summary?.summary?.actionItems?.[0] || context.subject || 'Review this conversation').slice(0, 300);
  const result = await callCloud('taskCreate', { id: crypto.randomUUID(), title, threadId: context.threadId, mailbox: context.owner.email });
  return result.ok ? `Task saved: ${title}. The source email is attached.` : `Could not save this task. ${result.reason}`;
}

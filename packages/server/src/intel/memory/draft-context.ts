import type { DraftRequest, SourceRef } from '@pigeonbox/api-contract';
import { parseAddressList } from '../../google/mime.js';
import type { IntelDeps } from '../context.js';
import { resolveAccount, threadRowId } from '../ids.js';
import { loadPreferences } from '../preferences.js';
import { resolveStyle } from '../writing.js';
import { getRelevantContext } from './retrieve.js';

export type CloudPromptContext = { text: string; corpus: string; sources: SourceRef[] };
/** The public AIProvider path shares the same retrieval engine as auto drafts. */
export async function personalDraftContext(
  deps: IntelDeps,
  userId: string,
  input: DraftRequest['input'],
  requestId: string,
): Promise<CloudPromptContext | null> {
  // Owner/selector is never authorization: resolve under the authenticated user.
  const loaded = await deps.db.asUser(userId, async (tx) => {
    const account = await resolveAccount(tx, { mailbox: input.owner?.email });
    if (!account || account.status !== 'active' || !account.features.includes('mail_read')) return null;
    const prefs = await loadPreferences(tx, userId);
    const id = input.threadId ? await threadRowId(tx, account.id, input.threadId) : null;
    const incoming = [...input.messages]
      .reverse()
      .flatMap((message) => parseAddressList(message.sender))
      .find((person) => person.email !== account.email.toLowerCase());
    const recipients = input.recipientEmails?.length ? input.recipientEmails : incoming ? [incoming.email] : [];
    const style = await resolveStyle(tx, userId, { recipient: recipients[0] ?? null, emailType: input.kind, voice: input.voice });
    return { prefs, id, recipients, style };
  });
  if (!loaded) return null;
  const selected = await getRelevantContext(deps, {
    userId,
    recipientEmails: loaded.recipients,
    currentThreadId: loaded.id,
    subject: input.subject,
    intent: input.kind,
    composeText: input.messages.at(-1)?.bodyText.slice(0, 700),
    prefs: loaded.prefs,
    now: deps.now(),
    requestId,
    maxTokens: 2_000,
  });
  return {
    text: JSON.stringify({
      sources: selected.map((item) => ({ id: item.ref.id, kind: item.ref.kind, text: item.text })),
      learnedWritingStyle: { formality: loaded.style.formality, targetWords: loaded.style.targetWords, notes: loaded.style.notes },
    }),
    corpus: selected.map((item) => item.text).join('\n'),
    sources: selected.map((item) => item.ref),
  };
}

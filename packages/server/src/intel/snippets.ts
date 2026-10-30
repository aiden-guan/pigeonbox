import type { Snippet, SourceRef } from '@pigeonbox/api-contract';
import { placeholderToken } from '@pigeonbox/shared';
import { InferenceError } from '../ai/backends.js';
import { iso, one, type SqlExecutor } from '../db/sql.js';
import { ApiError } from '../http.js';
import { BudgetExceededError, runStructured } from './ai.js';
import type { IntelDeps } from './context.js';
import { gmailFor, loadAccount } from './google-access.js';
import { loadPreferences } from './preferences.js';
import { snippetPrompt, SnippetOutputSchema } from './prompts.js';
import { availability, defaultWindow, formatSlot } from './scheduling.js';
import { readThread } from './thread-reader.js';

/**
 * Snippets with `{variable}` fields and `{AI: directive}` blocks. A directive
 * can read only the sources the snippet allows (thread, calendar, contact,
 * profile). Calendar directives are answered from real free/busy data; other
 * directives go to the model with just the allowed sources, and anything they
 * cannot support becomes a visible placeholder. Rendering is a preview; the
 * user inserts the text.
 */

const TOKEN = /\{\s*(AI\s*:\s*([^}]{1,500})|([a-z_][a-z0-9_]{0,39}))\s*\}/gi;

export function parseSnippet(body: string): { variables: string[]; directives: string[] } {
  const variables = new Set<string>();
  const directives: string[] = [];
  for (const match of body.matchAll(TOKEN)) {
    if (match[2]) directives.push(match[2].trim());
    else if (match[3]) variables.add(match[3].toLowerCase());
  }
  return { variables: [...variables].slice(0, 30), directives: directives.slice(0, 10) };
}

type Row = { id: string; name: string; body: string; workspace_id: string | null; allowed_sources: string[]; updated_at: unknown };

function toSnippet(row: Row): Snippet {
  const parsed = parseSnippet(row.body);
  return {
    id: row.id,
    name: row.name.slice(0, 120),
    body: row.body.slice(0, 10_000),
    scope: row.workspace_id ? 'workspace' : 'personal',
    workspaceId: row.workspace_id,
    variables: parsed.variables,
    directives: parsed.directives.map((prompt) => ({ prompt: prompt.slice(0, 500) })),
    allowedSources: row.allowed_sources as Snippet['allowedSources'],
    updatedAt: iso(row.updated_at),
  };
}

export async function listSnippets(tx: SqlExecutor): Promise<Snippet[]> {
  return (await tx.query<Row>(`select id, name, body, workspace_id, allowed_sources, updated_at from public.snippets order by workspace_id nulls first, name limit 500`)).map(toSnippet);
}

export async function saveSnippet(tx: SqlExecutor, userId: string, input: { id?: string; name: string; body: string; workspaceId: string | null; allowedSources: string[] }): Promise<Snippet> {
  const row = input.id
    ? await one<Row>(
        tx,
        `update public.snippets set name = $2, body = $3, allowed_sources = $4::text[], updated_at = now() where id = $1::uuid returning id, name, body, workspace_id, allowed_sources, updated_at`,
        [input.id, input.name, input.body, input.allowedSources],
      )
    : await one<Row>(
        tx,
        `insert into public.snippets (user_id, workspace_id, name, body, allowed_sources) values ($1::uuid, $2::uuid, $3, $4, $5::text[]) returning id, name, body, workspace_id, allowed_sources, updated_at`,
        [userId, input.workspaceId, input.name, input.body, input.allowedSources],
      ).catch(() => null);
  if (!row) throw new ApiError(input.id ? 'not_found' : 'forbidden', input.id ? 'That snippet does not exist or you cannot edit it.' : 'You can only add snippets to workspaces you belong to.');
  return toSnippet(row);
}

export async function deleteSnippet(tx: SqlExecutor, id: string): Promise<void> {
  const rows = await tx.query(`delete from public.snippets where id = $1::uuid returning id`, [id]);
  if (!rows.length) throw new ApiError('not_found', 'That snippet does not exist or you cannot delete it.');
}

export async function renderSnippet(
  deps: IntelDeps,
  userId: string,
  input: { snippetId: string; accountId: string | null; threadRowId: string | null; values: Record<string, string>; timeZone?: string; requestId: string },
): Promise<{ text: string; unresolved: string[]; sources: SourceRef[] }> {
  const context = await deps.db.asUser(userId, async (tx) => {
    const snippet = await one<Row>(tx, `select id, name, body, workspace_id, allowed_sources, updated_at from public.snippets where id = $1::uuid`, [input.snippetId]);
    if (!snippet) throw new ApiError('not_found', 'That snippet does not exist.');
    const prefs = await loadPreferences(tx, userId);
    const thread = input.threadRowId
      ? await one<{ gmail_thread_id: string; mail_account_id: string; subject: string }>(tx, `select gmail_thread_id, mail_account_id, subject from public.threads where id = $1::uuid`, [input.threadRowId])
      : null;
    const sender = input.threadRowId
      ? await one<{ from_email: string | null; from_name: string | null }>(tx, `select from_email, from_name from public.message_metadata where thread_id = $1::uuid and direction = 'inbound' order by internal_date desc limit 1`, [input.threadRowId])
      : null;
    const contact = sender?.from_email
      ? await one<{ name: string | null; company: string | null }>(tx, `select c.name, co.name as company from public.contacts c left join public.companies co on co.id = c.company_id where c.email_normalized = lower($1)`, [sender.from_email])
      : null;
    const account = input.accountId ? await loadAccount(tx, input.accountId) : null;
    return { snippet, prefs, thread, sender, contact, account };
  });
  const { snippet, prefs, thread, sender, contact, account } = context;
  const allowed = new Set(snippet.allowed_sources);
  const sources: SourceRef[] = [];
  const unresolved: string[] = [];
  const fullName = input.values.full_name ?? sender?.from_name ?? contact?.name ?? '';
  const known: Record<string, string> = {
    first_name: fullName.split(/\s+/)[0] ?? '',
    full_name: fullName,
    name: fullName,
    email: sender?.from_email ?? '',
    company: contact?.company ?? (sender?.from_email?.split('@')[1] ?? ''),
    subject: thread?.subject ?? '',
    my_name: prefs.voice?.name || account?.display_name || '',
    today: new Intl.DateTimeFormat('en-US', { timeZone: prefs.timeZone, weekday: 'long', month: 'long', day: 'numeric' }).format(deps.now()),
  };
  if (thread && allowed.has('thread')) sources.push({ id: `thread:${thread.gmail_thread_id}`, kind: 'thread', title: thread.subject || '(no subject)', gmailThreadId: thread.gmail_thread_id, accountId: thread.mail_account_id });

  let threadText: string | null = null;
  const directiveResults = new Map<string, string>();
  for (const directive of parseSnippet(snippet.body).directives) {
    if (directiveResults.has(directive)) continue;
    const lower = directive.toLowerCase();
    // Availability from the real calendar, never from the model.
    if (/\b(opening|openings|slots?|times?|available|availability|free)\b/.test(lower)) {
      if (!allowed.has('calendar') || !account?.features.includes('calendar_read')) {
        directiveResults.set(directive, placeholderToken('time'));
        unresolved.push('Available times (calendar not allowed or not connected)');
        continue;
      }
      const minutes = Number(lower.match(/(\d{1,3})[\s-]?min/)?.[1] ?? prefs.calendar.defaultDurationMinutes);
      const count = Number(lower.match(/\b(two|three|four|2|3|4)\b/)?.[1]?.replace('two', '2').replace('three', '3').replace('four', '4') ?? 3);
      let window = defaultWindow(deps.now(), prefs);
      if (/next week/.test(lower)) window = { start: new Date(deps.now().getTime() + ((8 - new Date(deps.now()).getUTCDay()) % 7 || 7) * 86_400_000), end: window.end };
      const found = await availability(deps, account, prefs, { durationMinutes: minutes, window, count, preferMornings: /morning/.test(lower) || undefined, timeZone: input.timeZone });
      sources.push({ id: `availability:${found.busyHash}`, kind: 'calendar_event', title: 'Your availability', accountId: account.id });
      directiveResults.set(directive, found.slots.length ? found.slots.map((slot) => `• ${formatSlot(slot, found.timeZone)}`).join('\n') : placeholderToken('time'));
      if (!found.slots.length) unresolved.push('No open times matched');
      continue;
    }
    const allowedSources: Array<{ id: string; kind: string; title: string; text: string }> = [];
    if (allowed.has('thread') && thread && account) {
      if (threadText === null) {
        const read = await readThread(gmailFor(deps, account), thread.gmail_thread_id, [account.email]).catch(() => null);
        threadText = read ? read.messages.filter((message) => message.direction === 'inbound').slice(-1)[0]?.text.slice(0, 3_000) ?? '' : '';
      }
      if (threadText) allowedSources.push({ id: 'S1', kind: 'thread', title: thread.subject, text: threadText });
    }
    if (allowed.has('contact') && contact) allowedSources.push({ id: `S${allowedSources.length + 1}`, kind: 'contact', title: contact.name ?? 'Contact', text: `${contact.name ?? ''} ${contact.company ? `at ${contact.company}` : ''}` });
    if (allowed.has('profile') && prefs.voice?.about) allowedSources.push({ id: `S${allowedSources.length + 1}`, kind: 'note', title: 'About you', text: prefs.voice.about });
    if (!allowedSources.length) {
      directiveResults.set(directive, placeholderToken('fact'));
      unresolved.push(`${directive.slice(0, 50)} (no allowed source)`);
      continue;
    }
    try {
      const prompt = snippetPrompt(directive, { sources: allowedSources, now: deps.now().toISOString(), timeZone: prefs.timeZone });
      const run = await runStructured(deps, { userId, operation: 'snippet', system: prompt.system, user: prompt.user, schema: SnippetOutputSchema, maxTokens: 300, interactive: true, requestId: input.requestId });
      directiveResults.set(directive, run.value.text.trim() || placeholderToken('fact'));
      if (run.value.unresolved) unresolved.push(directive.slice(0, 60));
    } catch (error) {
      if (!(error instanceof BudgetExceededError || error instanceof InferenceError)) throw error;
      directiveResults.set(directive, placeholderToken('fact'));
      unresolved.push(`${directive.slice(0, 50)} (AI unavailable)`);
    }
  }
  const text = snippet.body.replace(TOKEN, (_whole, _inner: string, directive: string | undefined, variable: string | undefined) => {
    if (directive) return directiveResults.get(directive.trim()) ?? placeholderToken('fact');
    const key = variable!.toLowerCase();
    const value = input.values[key] ?? known[key];
    if (value) return value;
    unresolved.push(key);
    return `[${key.replace(/_/g, ' ').toUpperCase()} NEEDED]`;
  });
  return { text: text.slice(0, 20_000), unresolved: [...new Set(unresolved)].slice(0, 30).map((item) => item.slice(0, 60)), sources: sources.slice(0, 20) };
}

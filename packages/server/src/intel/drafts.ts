import type { ProcessingTier } from '../ai/policy.js';
import { getRelevantContext } from './memory/retrieve.js';
import { memoryState } from './memory/store.js';
import type { CloudDraft, DraftKind, DraftListResponse, DraftListStatus, DraftVariant, SourceRef } from '@pigeonbox/api-contract';
import { findPlaceholders } from '@pigeonbox/shared';
import { InferenceError } from '../ai/backends.js';
import { iso, isoOrNull, num, one, type SqlExecutor } from '../db/sql.js';
import { GoogleApiError } from '../google/errors.js';
import { buildRawMessage, parseRawMessage, replySubject } from '../google/mime.js';
import { ApiError } from '../http.js';
import { sha256Hex, type SecretBox } from '../platform/crypto.js';
import { BudgetExceededError, runStructured } from './ai.js';
import { recordAudit } from './audit.js';
import { buildContextPack, promptSources, type ContextPack } from './context-pack.js';
import type { IntelDeps } from './context.js';
import { gmailFor, loadAccount, requireFeature, type AccountRow } from './google-access.js';
import { buildFactIndex, groundDraft, similarity } from './grounding.js';
import { decide } from './policy.js';
import { loadPreferences } from './preferences.js';
import { draftPrompt, DraftOutputSchema, type DraftOutput, type MeetingContext } from './prompts.js';
import { boundThread, readThread, replyRecipients, threadPeople } from './thread-reader.js';
import { learnFromEdit } from './writing.js';
import { notify } from './notifications.js';
import { ensureRecipientGreeting, ensureSignature, signerName } from './draft-identity.js';
export { ensureSignature, signerName } from './draft-identity.js';

/**
 * Proactive, grounded drafts.
 *
 * - One live draft per thread and kind. A new message makes it stale; it is
 *   regenerated as a new version, never as a second draft.
 * - A draft the user edited (in Gmail or reported as edited) is never
 *   overwritten.
 * - Every version records the sources it used; the draft text is encrypted.
 * - Unknown facts become explicit placeholders (grounding.ts).
 * - Placing a draft in Gmail is Tier 2: user-initiated, or automatic only if
 *   the user enabled it. Nothing here sends mail.
 */

const FRESHNESS_HOURS: Record<DraftKind, number> = { reply: 24 * 7, follow_up: 24 * 3, scheduling: 24, acknowledgment: 24 * 2, info_request: 24 * 7 };

type DraftRow = {
  id: string;
  user_id: string;
  mail_account_id: string;
  thread_id: string;
  gmail_thread_id: string;
  content_version: string;
  kind: DraftKind;
  status: CloudDraft['status'];
  origin: string;
  based_on_message_id: string | null;
  based_on_version: string | null;
  voice_level: CloudDraft['voice'];
  stale_reason: string | null;
  refresh_after: unknown;
  gmail_draft_id: string | null;
  placed_variant_id: string | null;
  placed_hash: string | null;
  error_code: string | null;
  current_version: number;
  created_at: unknown;
  updated_at: unknown;
};

const DRAFT_COLUMNS = `d.id, d.user_id, d.mail_account_id, d.thread_id, t.gmail_thread_id, t.content_version, d.kind, d.status, d.origin, d.based_on_message_id,
  d.based_on_version, d.voice_level, d.stale_reason, d.refresh_after, d.gmail_draft_id, d.placed_variant_id, d.placed_hash, d.error_code,
  d.current_version, d.created_at, d.updated_at`;

type StoredVariant = DraftVariant;

async function readVariants(tx: SqlExecutor, box: SecretBox, userId: string, draftId: string, version: number): Promise<StoredVariant[]> {
  const row = await one<{ variants_key_id: string; variants_iv: string; variants_ciphertext: string }>(
    tx,
    `select variants_key_id, variants_iv, variants_ciphertext from public.draft_versions where draft_id = $1::uuid and version = $2`,
    [draftId, version],
  );
  if (!row) return [];
  try {
    const plain = await box.open({ keyId: row.variants_key_id, iv: row.variants_iv, ciphertext: row.variants_ciphertext }, { purpose: 'draft', userId, recordId: `${draftId}:${version}` });
    return JSON.parse(plain) as StoredVariant[];
  } catch {
    return [];
  }
}

async function readSources(tx: SqlExecutor, draftId: string, version: number): Promise<SourceRef[]> {
  const rows = await tx.query<{ kind: SourceRef['kind']; ref_id: string; title: string; gmail_thread_id: string | null; gmail_message_id: string | null; url: string | null; at: unknown; who: string | null; source_version: string | null }>(
    `select kind, ref_id, title, gmail_thread_id, gmail_message_id, url, at, who, source_version from public.draft_sources where draft_id = $1::uuid and version = $2 order by ordinal`,
    [draftId, version],
  );
  return rows.map((row) => ({
    id: row.ref_id.slice(0, 128),
    kind: row.kind,
    title: row.title.slice(0, 300),
    ...(row.gmail_thread_id ? { gmailThreadId: row.gmail_thread_id } : {}),
    ...(row.gmail_message_id ? { gmailMessageId: row.gmail_message_id } : {}),
    ...(row.url ? { url: row.url } : {}),
    ...(row.at ? { at: iso(row.at) } : {}),
    ...(row.who ? { who: row.who.slice(0, 320) } : {}),
    ...(row.source_version ? { version: row.source_version.slice(0, 128) } : {}),
  }));
}

/** Staleness as of now: newer thread activity or an expired freshness window. */
function effectiveStatus(row: DraftRow, now: Date): { status: CloudDraft['status']; staleReason: string | null } {
  if (row.status === 'ready' || row.status === 'placed') {
    if (row.based_on_version && row.based_on_version !== row.content_version) return { status: 'stale', staleReason: 'New activity in the thread since this draft' };
    const refresh = row.refresh_after ? Date.parse(iso(row.refresh_after)) : NaN;
    if (Number.isFinite(refresh) && refresh < now.getTime()) return { status: 'stale', staleReason: 'Older than its freshness window' };
  }
  return { status: row.status, staleReason: row.stale_reason };
}

async function toDraft(tx: SqlExecutor, box: SecretBox, userId: string, row: DraftRow, now: Date): Promise<CloudDraft> {
  const version = row.current_version;
  const variants = version > 0 ? await readVariants(tx, box, userId, row.id, version) : [];
  const { status, staleReason } = effectiveStatus(row, now);
  return {
    id: row.id,
    threadId: row.gmail_thread_id,
    accountId: row.mail_account_id,
    kind: row.kind,
    status,
    variants: variants.slice(0, 3),
    sources: version > 0 ? (await readSources(tx, row.id, version)).slice(0, 24) : [],
    freshness: { createdAt: iso(row.updated_at), basedOnMessageId: row.based_on_message_id, staleReason: staleReason?.slice(0, 200) ?? null, refreshAfter: isoOrNull(row.refresh_after) },
    voice: row.voice_level,
    gmailDraftId: row.gmail_draft_id,
    placedVariantId: row.placed_variant_id,
    errorCode: row.error_code,
  };
}

export async function loadLiveDraft(tx: SqlExecutor, box: SecretBox, userId: string, threadRowId: string, kind?: DraftKind, now = new Date()): Promise<CloudDraft | null> {
  const row = await one<DraftRow>(
    tx,
    `select ${DRAFT_COLUMNS} from public.drafts d join public.threads t on t.id = d.thread_id
      where d.thread_id = $1::uuid and d.status in ('preparing', 'ready', 'stale', 'user_edited', 'placed') ${kind ? 'and d.kind = $2' : ''}
      order by d.updated_at desc limit 1`,
    kind ? [threadRowId, kind] : [threadRowId],
  );
  return row ? toDraft(tx, box, userId, row, now) : null;
}

export async function loadDraftById(tx: SqlExecutor, box: SecretBox, userId: string, draftId: string, now = new Date()): Promise<CloudDraft | null> {
  const row = await one<DraftRow>(tx, `select ${DRAFT_COLUMNS} from public.drafts d join public.threads t on t.id = d.thread_id where d.id = $1::uuid`, [draftId]);
  return row ? toDraft(tx, box, userId, row, now) : null;
}

const LIVE_STATUSES = `('preparing', 'ready', 'stale', 'user_edited', 'placed')`;
/** A draft that could not be prepared stays visible this long, so the user can try again. */
const FAILED_VISIBLE_MS = 7 * 86_400_000;

/** Live drafts with their effective status ($1 now, $2 account or null, $3 failed cutoff). */
const LIVE_DRAFTS_CTE = `
    with live as (
      select ${DRAFT_COLUMNS}, t.subject, t.last_message_at, date_trunc('milliseconds', d.updated_at) as page_at,
             case when d.status in ('ready', 'placed')
                   and ((d.based_on_version is not null and d.based_on_version <> t.content_version) or (d.refresh_after is not null and d.refresh_after < $1::timestamptz))
                  then 'stale' else d.status end as effective
        from public.drafts d join public.threads t on t.id = d.thread_id
       where ($2::uuid is null or d.mail_account_id = $2::uuid)
         and (d.status in ${LIVE_STATUSES}
              or (d.status = 'failed' and d.updated_at > $3::timestamptz
                  and not exists (select 1 from public.drafts o where o.thread_id = d.thread_id and o.kind = d.kind and o.status in ${LIVE_STATUSES})))
    )`;

function liveDraftParams(accountId: string | null, now: Date): unknown[] {
  return [now, accountId, new Date(now.getTime() - FAILED_VISIBLE_MS)];
}

/** Totals by effective status, for the Drafts filters and the Home summary. */
export async function draftCounts(tx: SqlExecutor, accountId: string | null, now: Date): Promise<DraftListResponse['counts']> {
  const rows = await tx.query<{ effective: DraftListStatus; n: number }>(`${LIVE_DRAFTS_CTE} select effective, count(*)::int as n from live group by effective`, liveDraftParams(accountId, now));
  const counts: DraftListResponse['counts'] = { preparing: 0, ready: 0, stale: 0, user_edited: 0, placed: 0, failed: 0 };
  for (const row of rows) if (row.effective in counts) counts[row.effective] = num(row.n);
  return counts;
}

/**
 * Every prepared draft for the signed-in user (RLS scopes `public.drafts`),
 * newest first. Status filtering, counts and pagination use the same
 * effective status as `effectiveStatus`, computed in SQL so a page is never
 * short. Draft text is decrypted only for the returned page.
 */
export async function listDrafts(
  tx: SqlExecutor,
  box: SecretBox,
  userId: string,
  input: { accountId: string | null; statuses?: DraftListStatus[]; limit: number; cursor?: string; now: Date },
): Promise<DraftListResponse> {
  let after: { at: Date; id: string } | null = null;
  if (input.cursor) {
    const [at, id] = input.cursor.split('|');
    const time = Date.parse(at ?? '');
    if (!Number.isFinite(time) || !id || !/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError('invalid_request', 'That page of drafts is no longer available. Refresh the list.');
    after = { at: new Date(time), id };
  }
  const base = liveDraftParams(input.accountId, input.now);
  const counts = await draftCounts(tx, input.accountId, input.now);
  const rows = await tx.query<DraftRow & { subject: string; last_message_at: unknown; page_at: unknown; person_email: string | null; person_name: string | null }>(
    `${LIVE_DRAFTS_CTE}
     select l.*, p.email as person_email, p.name as person_name
       from live l
       left join lateral (
         select case when l.kind = 'follow_up' then m.to_emails[1] else m.from_email end as email,
                case when l.kind = 'follow_up' then null else nullif(m.from_name, '') end as name
           from public.message_metadata m
          where m.thread_id = l.thread_id and m.direction = case when l.kind = 'follow_up' then 'outbound' else 'inbound' end
          order by m.internal_date desc limit 1) p on true
      where ($4::text[] is null or l.effective = any($4::text[]))
        and ($5::timestamptz is null or (l.page_at, l.id) < ($5::timestamptz, $6::uuid))
      order by l.page_at desc, l.id desc
      limit $7`,
    [...base, input.statuses ?? null, after?.at ?? null, after?.id ?? null, input.limit + 1],
  );
  const page = rows.slice(0, input.limit);
  const drafts: DraftListResponse['drafts'] = [];
  for (const row of page) {
    drafts.push({
      draft: await toDraft(tx, box, userId, row, input.now),
      subject: (row.subject || '(no subject)').slice(0, 998),
      person: row.person_email ? { email: row.person_email.slice(0, 320), ...(row.person_name ? { name: row.person_name.slice(0, 200) } : {}) } : null,
      lastMessageAt: iso(row.last_message_at),
    });
  }
  const last = page[page.length - 1];
  return { drafts, counts, nextCursor: rows.length > input.limit && last ? `${iso(last.page_at)}|${last.id}` : null };
}

/** New thread activity: live drafts built on an older version become stale (user-edited ones keep their status). */
export async function markDraftsStale(tx: SqlExecutor, threadRowIds: string[], reason: string): Promise<number> {
  if (!threadRowIds.length) return 0;
  const rows = await tx.query<{ id: string }>(
    `update public.drafts d set status = 'stale', stale_reason = $2, updated_at = now()
       from public.threads t
      where t.id = d.thread_id and d.thread_id = any($1::uuid[]) and d.status in ('ready', 'placed')
        and d.based_on_version is distinct from t.content_version
      returning d.id`,
    [threadRowIds, reason],
  );
  return rows.length;
}

function selectVariants(output: DraftOutput, allowVariants: boolean): DraftOutput['variants'] {
  const out: DraftOutput['variants'] = [];
  const labels = new Set<string>();
  for (const [index, variant] of output.variants.entries()) {
    const label = index === 0 ? 'recommended' : variant.label === 'recommended' ? 'alternative' : variant.label;
    if (labels.has(label)) continue;
    // No fake variety: a variant that says the same thing as one we kept is dropped.
    if (out.some((kept) => similarity(kept.body, variant.body) > 0.72)) continue;
    labels.add(label);
    out.push({ ...variant, label });
    if (!allowVariants || out.length === 3) break;
  }
  return out;
}

export type PrepareOptions = {
  threadRowId: string;
  kind?: DraftKind;
  origin: 'auto' | 'user' | 'follow_up' | 'scheduling' | 'ask' | 'automation';
  instructions?: string | null;
  force?: boolean;
  followUpId?: string | null;
  requestId: string;
  interactive: boolean;
  /** Forces the processing tier for a background call that cannot be retried later (see policy.ts). */
  tier?: ProcessingTier;
  meeting?: MeetingContext | null;
};

async function gmailDraftBody(deps: IntelDeps, account: AccountRow, gmailDraftId: string): Promise<string | null> {
  try {
    const draft = await gmailFor(deps, account).getDraft(gmailDraftId);
    const raw = (draft.message as { raw?: string } | undefined)?.raw;
    return raw ? parseRawMessage(raw).body : null;
  } catch (error) {
    if (error instanceof GoogleApiError && error.code === 'not_found') return null;
    throw error;
  }
}

/**
 * Prepare (or refresh) the draft for a thread. Returns the existing draft
 * untouched when it is current, user-edited, or already being prepared.
 */
export async function prepareDraft(deps: IntelDeps, userId: string, options: PrepareOptions): Promise<CloudDraft> {
  const loaded = await deps.db.asUser(userId, async (tx) => {
    const thread = await one<{ id: string; mail_account_id: string; gmail_thread_id: string; content_version: string; meeting_request: Partial<MeetingContext> | null; meeting_version: string | null; injection_suspected: boolean | null }>(
      tx,
      `select t.id, t.mail_account_id, t.gmail_thread_id, t.content_version, s.meeting_request, s.analyzed_version as meeting_version, s.injection_suspected
         from public.threads t left join public.thread_states s on s.thread_id = t.id where t.id = $1::uuid`,
      [options.threadRowId],
    );
    if (!thread) throw new ApiError('not_found', 'That thread is not synced.');
    const account = await loadAccount(tx, thread.mail_account_id);
    const prefs = await loadPreferences(tx, userId);
    const kind: DraftKind = options.kind ?? (thread.meeting_request?.isScheduling ? 'scheduling' : 'reply');
    const existing = await one<DraftRow>(
      tx,
      `select ${DRAFT_COLUMNS} from public.drafts d join public.threads t on t.id = d.thread_id
        where d.thread_id = $1::uuid and d.kind = $2 and d.status in ('preparing', 'ready', 'stale', 'user_edited', 'placed')`,
      [thread.id, kind],
    );
    return { thread, account, prefs, kind, existing };
  });
  const { thread, account, prefs, kind } = loaded;
  let existing = loaded.existing;
  if (!account || account.status !== 'active') throw new ApiError('conflict', 'Reconnect this Google account first.');
  requireFeature(account, 'mail_read');

  if (existing) {
    if (existing.status === 'user_edited' && !options.force) return deps.db.asUser(userId, (tx) => toDraft(tx, deps.box, userId, existing!, deps.now()));
    // A Gmail draft whose text differs from what PigeonBox placed was edited by the user: never overwrite it.
    if (existing.gmail_draft_id && existing.placed_hash) {
      const body = await gmailDraftBody(deps, account, existing.gmail_draft_id);
      const edited = body !== null && (await sha256Hex(body.trim())) !== existing.placed_hash;
      if (edited || body === null) {
        const status = edited ? 'user_edited' : 'discarded';
        await deps.db.asUser(userId, (tx) =>
          tx.query(`update public.drafts set status = $2, stale_reason = $3, updated_at = now() where id = $1::uuid`, [
            existing!.id,
            status,
            edited ? 'You edited this draft in Gmail' : 'The Gmail draft was deleted or sent',
          ]),
        );
        if (edited) {
          const current = await deps.db.asUser(userId, (tx) => loadDraftById(tx, deps.box, userId, existing!.id, deps.now()));
          return current!;
        }
        existing = null;
      }
    }
    if (existing) {
      const { status } = effectiveStatus(existing, deps.now());
      const sameInstructions = !options.instructions;
      if (!options.force && sameInstructions && (status === 'ready' || status === 'placed') && existing.based_on_version === thread.content_version) {
        const cached = await deps.db.asUser(userId, (tx) => toDraft(tx, deps.box, userId, existing!, deps.now()));
        const signer = signerName(prefs.voice?.name, account.display_name);
        // Refresh older generated signatures on the next preparation. Placed/edited Gmail drafts stay untouched.
        if (status === 'placed' || cached.variants.every((variant) => ensureSignature(variant.body, signer) === variant.body)) return cached;
      }
    }
  }

  // Claim the draft row (or create it) before the slow part, so concurrent jobs do not both generate.
  const draftId = await deps.db.asUser(userId, async (tx) => {
    if (existing) {
      await tx.query(`update public.drafts set status = 'preparing', error_code = null, updated_at = now() where id = $1::uuid`, [existing.id]);
      return existing.id;
    }
    const row = await one<{ id: string }>(
      tx,
      `insert into public.drafts (user_id, mail_account_id, thread_id, kind, status, origin) values ($1::uuid, $2::uuid, $3::uuid, $4, 'preparing', $5)
       on conflict (thread_id, kind) where status in ('preparing', 'ready', 'stale', 'user_edited', 'placed') do nothing returning id`,
      [userId, account.id, thread.id, kind, options.origin],
    );
    if (row) return row.id;
    const other = await one<{ id: string }>(tx, `select id from public.drafts where thread_id = $1::uuid and kind = $2 and status in ('preparing', 'ready', 'stale', 'user_edited', 'placed')`, [thread.id, kind]);
    return other!.id;
  });

  try {
    const read = await readThread(gmailFor(deps, account), thread.gmail_thread_id, [account.email]);
    const bounded = { ...read, messages: boundThread(read.messages) };
    const meeting = options.meeting ?? (thread.meeting_request ? {
      isScheduling: Boolean(thread.meeting_request.isScheduling),
      durationMinutes: thread.meeting_request.durationMinutes ?? null,
      constraints: Array.isArray(thread.meeting_request.constraints) ? thread.meeting_request.constraints.slice(0, 6) : [],
      requestedWindow: thread.meeting_version === thread.content_version ? thread.meeting_request.requestedWindow : null,
    } : null);
    const recipientEmails = replyRecipients(bounded, account.email, kind === 'follow_up' ? 'follow_up' : 'reply').to.map((person) => person.email);
    const relevantContext = await getRelevantContext(deps,{ userId,recipientEmails: recipientEmails.filter((email) => email && email !== account.email),
      currentThreadId: thread.id,subject: bounded.subject,composeText: options.instructions ?? '',intent: kind,
      prefs,now: deps.now(),requestId: options.requestId,maxTokens: 2_000,maxItems: 10 });
    // Calendar access can refresh credentials through its own RLS transaction.
    // Keep network work outside a database transaction to avoid nested waits.
    const pack = await buildContextPack(deps, { relevantContext, userId, account, threadRowId: thread.id, thread: bounded, kind, prefs, meeting, box: deps.box });
    const allowVariants = kind === 'reply' || kind === 'scheduling';
    const prompt = draftPrompt({
      kind,
      now: deps.now().toISOString(),
      timeZone: prefs.timeZone,
      owner: { ...pack.owner, signName: signerName(prefs.voice?.name, account.display_name) },
      recipients: pack.to.map((person) => ({ email: person.email, name: person.name ?? null })),
      subject: pack.subject,
      thread: bounded.messages.map((message) => ({ from: message.fromName ? `${message.fromName} <${message.from}>` : message.from, date: message.date, direction: message.direction, text: message.text })),
      sources: promptSources(pack),
      style: {
        greeting: pack.style.greeting,
        signoff: pack.style.signoff,
        targetWords: pack.style.targetWords,
        formality: pack.style.formality,
        bullets: pack.style.bullets,
        emoji: pack.style.emoji,
        notes: pack.style.notes,
      },
      instructions: options.instructions ?? null,
      allowVariants,
    });
    const run = await runStructured(deps, {
      userId,
      operation: 'grounded_draft',
      system: prompt.system,
      user: prompt.user,
      schema: DraftOutputSchema,
      maxTokens: 1_400,
      interactive: options.interactive,
      tier: options.tier,
      requestId: options.requestId,
    });
    return await saveGeneratedDraft(deps, userId, { draftId, pack, output: run.value, model: run.model, allowVariants, thread, kind, account, followUpId: options.followUpId ?? null, origin: options.origin, prefs });
  } catch (error) {
    const code = error instanceof BudgetExceededError ? error.message : error instanceof InferenceError ? error.code : error instanceof GoogleApiError ? `google_${error.code}` : 'draft_failed';
    await deps.db.asUser(userId, (tx) =>
      tx.query(`update public.drafts set status = case when current_version > 0 then 'stale' else 'failed' end, error_code = $2, updated_at = now() where id = $1::uuid`, [draftId, code]),
    );
    throw error;
  }
}

async function saveGeneratedDraft(
  deps: IntelDeps,
  userId: string,
  input: {
    draftId: string;
    pack: ContextPack;
    output: DraftOutput;
    model: string | null;
    allowVariants: boolean;
    thread: { id: string; gmail_thread_id: string; content_version: string };
    kind: DraftKind;
    account: AccountRow;
    followUpId: string | null;
    origin: PrepareOptions['origin'];
    prefs: Awaited<ReturnType<typeof loadPreferences>>;
  },
): Promise<CloudDraft> {
  const { pack } = input;
  const index = buildFactIndex(pack.corpus);
  let groundingEdits = 0;
  const usedIds = new Set<string>(['S1']);
  const signer = signerName(input.prefs.voice?.name, input.account.display_name);
  const variants: StoredVariant[] = selectVariants(input.output, input.allowVariants).map((variant) => {
    const cc = threadPeople(pack.thread.messages).filter((person) => pack.cc.includes(person.email));
    const body = ensureRecipientGreeting(variant.body, [...pack.to, ...cc]);
    const grounded = groundDraft(ensureSignature(body, signer, pack.style.signoff), index);
    groundingEdits += grounded.edits;
    for (const id of variant.usedSources) usedIds.add(id);
    return {
      id: crypto.randomUUID(),
      label: variant.label,
      strategy: variant.strategy.slice(0, 200) || (variant.label === 'recommended' ? 'Recommended' : variant.label === 'shorter' ? 'Shorter' : 'Different approach'),
      subject: replySubject(pack.subject).slice(0, 998),
      body: grounded.body.slice(0, 20_000),
      placeholders: grounded.placeholders.slice(0, 20).map((p) => ({ token: p.token.slice(0, 64), kind: p.kind, mode: p.mode, label: p.label.slice(0, 120) })),
    };
  });
  // Sources the model relied on, plus availability (always shown when used for a scheduling draft).
  const used = pack.sources.filter((source) => usedIds.has(source.promptId) || source.ref.kind === 'calendar_event' || source.ref.kind === 'commitment');

  const draft = await deps.db.asUser(userId, async (tx) => {
    const current = await one<{ current_version: number }>(tx, `select current_version from public.drafts where id = $1::uuid`, [input.draftId]);
    const version = (current?.current_version ?? 0) + 1;
    const sealed = await deps.box.seal(JSON.stringify(variants), { purpose: 'draft', userId, recordId: `${input.draftId}:${version}` });
    await tx.query(
      `insert into public.draft_versions (draft_id, user_id, version, variants_key_id, variants_iv, variants_ciphertext, variant_count, grounding_edits, model)
       values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)`,
      [input.draftId, userId, version, sealed.keyId, sealed.iv, sealed.ciphertext, variants.length, groundingEdits, input.model],
    );
    for (const [ordinal, source] of used.entries()) {
      await tx.query(
        `insert into public.draft_sources (draft_id, user_id, version, ordinal, kind, ref_id, title, gmail_thread_id, gmail_message_id, url, at, who, source_version)
         values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12, $13)`,
        [
          input.draftId,
          userId,
          version,
          ordinal,
          source.ref.kind,
          source.ref.id,
          source.ref.title,
          source.ref.gmailThreadId ?? null,
          source.ref.gmailMessageId ?? null,
          source.ref.url ?? null,
          source.ref.at ? new Date(source.ref.at) : null,
          source.ref.who ?? null,
          source.ref.version ?? null,
        ],
      );
    }
    const refreshAfter = new Date(deps.now().getTime() + FRESHNESS_HOURS[input.kind] * 3_600_000);
    await tx.query(
      `update public.drafts set status = 'ready', current_version = $2, based_on_message_id = $3, based_on_version = $4, voice_level = $5,
              stale_reason = null, refresh_after = $6::timestamptz, error_code = null, updated_at = now() where id = $1::uuid`,
      [input.draftId, version, pack.basedOnMessageId, input.thread.content_version, pack.style.level, refreshAfter],
    );
    if (input.followUpId) await tx.query(`update public.follow_ups set draft_id = $2::uuid, updated_at = now() where id = $1::uuid`, [input.followUpId, input.draftId]);
    if (input.origin !== 'user') {
      await notify(tx, {
        userId,
        kind: 'draft_ready',
        title: `Draft ready: ${(pack.subject || '(no subject)').slice(0, 150)}`,
        body: `${variants.length > 1 ? `${variants.length} options` : 'A draft'} to review${variants.some((variant) => variant.placeholders.length) ? ', with details to fill in' : ''}.`,
        accountId: input.account.id,
        threadId: input.thread.gmail_thread_id,
        refId: input.draftId,
        dedupeKey: `draft:${input.draftId}:${version}`,
      }, deps.now());
    }
    return loadDraftById(tx, deps.box, userId, input.draftId, deps.now());
  });

  // Automatic Gmail placement only when the user turned it on (Tier 2 policy), and only for PigeonBox's own drafts.
  if (
    draft &&
    input.origin !== 'user' &&
    input.prefs.autoDrafts.placeInGmail &&
    input.account.features.includes('drafts') &&
    decide({ tier: 2, actor: input.origin === 'follow_up' ? 'follow_up' : 'system', userInitiated: false, autoPlaceDrafts: true }).decision === 'allowed'
  ) {
    try {
      return await placeDraft(deps, userId, { draftId: draft.id, variantId: draft.variants[0]!.id, idempotencyKey: `auto:${draft.id}:${draft.variants[0]!.id}` }, { type: 'system', name: 'Auto drafts' });
    } catch (error) {
      deps.log('warn', 'automatic draft placement failed', { userId, accountId: input.account.id, code: (error as { code?: string })?.code ?? 'error' });
    }
  }
  return draft!;
}

/**
 * Put a draft variant into Gmail (create or update the Gmail draft). If the
 * Gmail draft changed since PigeonBox placed it, the user edited it: refuse.
 */
/**
 * Who a reply goes to: a follow-up goes back to whoever the user last wrote
 * to; a reply goes to the last sender, copying everyone else on that message.
 */
export async function replyAddressing(deps: IntelDeps, account: AccountRow, gmailThreadId: string, kind: DraftKind): Promise<{ to: string[]; cc: string[]; inReplyTo: string | null }> {
  // Read current headers only: Reply-To isn't stored in the synced metadata table.
  const thread = await readThread(gmailFor(deps, account), gmailThreadId, [account.email], 'metadata');
  const { to, cc } = replyRecipients(thread, account.email, kind === 'follow_up' ? 'follow_up' : 'reply');
  const base = [...thread.messages].reverse().find((message) => message.direction === (kind === 'follow_up' ? 'outbound' : 'inbound'));
  return { to: to.map((person) => person.email), cc, inReplyTo: base?.rfc822MessageId ?? null };
}

export async function placeDraft(
  deps: IntelDeps,
  userId: string,
  request: { draftId: string; variantId: string; body?: string; idempotencyKey: string },
  actor: { type: 'user' | 'system' | 'mcp' | 'automation'; name: string } = { type: 'user', name: 'You' },
): Promise<CloudDraft> {
  const loaded = await deps.db.asUser(userId, async (tx) => {
    const row = await one<DraftRow & { subject: string }>(tx, `select ${DRAFT_COLUMNS}, t.subject from public.drafts d join public.threads t on t.id = d.thread_id where d.id = $1::uuid`, [request.draftId]);
    if (!row) throw new ApiError('not_found', 'That draft does not exist.');
    const done = await one(tx, `select 1 from public.audit_events where idempotency_key = $1`, [`place:${request.idempotencyKey}`]);
    const account = await loadAccount(tx, row.mail_account_id);
    const variants = await readVariants(tx, deps.box, userId, row.id, row.current_version);
    return { row, done: Boolean(done), account, variants };
  });
  const { row, account } = loaded;
  if (loaded.done) return (await deps.db.asUser(userId, (tx) => loadDraftById(tx, deps.box, userId, row.id, deps.now())))!;
  if (!account) throw new ApiError('conflict', 'Reconnect this Google account first.');
  try {
    requireFeature(account, 'drafts');
  } catch {
    throw new ApiError('forbidden', 'Turn on "Create drafts" for this Google account to place drafts in Gmail.');
  }
  const variant = loaded.variants.find((item) => item.id === request.variantId);
  if (!variant) throw new ApiError('not_found', 'That draft option does not exist.');
  const body = (request.body ?? variant.body).trim();
  const policy = decide({ tier: 2, actor: actor.type === 'mcp' ? 'mcp' : actor.type === 'user' ? 'user' : 'system', userInitiated: actor.type === 'user', autoPlaceDrafts: actor.type === 'system', scopes: actor.type === 'mcp' ? ['write'] : undefined });
  if (policy.decision !== 'allowed') throw new ApiError('forbidden', policy.reason);

  const gmail = gmailFor(deps, account);
  // Never overwrite a Gmail draft the user edited. Automatic placement stops; an explicit
  // placement by the user creates a separate Gmail draft and leaves the edited one alone.
  let keepExisting = false;
  if (row.gmail_draft_id && row.placed_hash) {
    const current = await gmailDraftBody(deps, account, row.gmail_draft_id);
    if (current !== null && (await sha256Hex(current.trim())) !== row.placed_hash) {
      if (actor.type !== 'user') {
        await deps.db.asUser(userId, (tx) => tx.query(`update public.drafts set status = 'user_edited', stale_reason = 'You edited this draft in Gmail', updated_at = now() where id = $1::uuid`, [row.id]));
        throw new ApiError('conflict', 'You edited this draft in Gmail, so PigeonBox left it alone.');
      }
      keepExisting = true;
    }
  }
  const addressing = await replyAddressing(deps, account, row.gmail_thread_id, row.kind);
  const raw = buildRawMessage({
    to: addressing.to.map((email) => ({ email })),
    cc: addressing.cc.map((email) => ({ email })),
    subject: replySubject(loaded.row.subject),
    body,
    inReplyTo: addressing.inReplyTo,
    references: addressing.inReplyTo,
  });
  let gmailDraftId = keepExisting ? null : row.gmail_draft_id;
  try {
    if (gmailDraftId) {
      try {
        gmailDraftId = (await gmail.updateDraft(gmailDraftId, row.gmail_thread_id, raw)).id;
      } catch (error) {
        if (!(error instanceof GoogleApiError && error.code === 'not_found')) throw error;
        gmailDraftId = (await gmail.createDraft(row.gmail_thread_id, raw)).id;
      }
    } else {
      gmailDraftId = (await gmail.createDraft(row.gmail_thread_id, raw)).id;
    }
  } catch (error) {
    if (error instanceof GoogleApiError) throw new ApiError(error.retryable ? 'provider_unavailable' : 'forbidden', 'Gmail did not accept the draft. Check the Google connection.');
    throw error;
  }
  const hash = await sha256Hex(body);
  return deps.db.asUser(userId, async (tx) => {
    await tx.query(
      `update public.drafts set status = 'placed', gmail_draft_id = $2, placed_variant_id = $3::uuid, placed_hash = $4, updated_at = now() where id = $1::uuid`,
      [row.id, gmailDraftId, variant.id, hash],
    );
    await recordAudit(tx, {
      userId,
      actor: { type: actor.type === 'mcp' ? 'mcp' : actor.type === 'automation' ? 'automation' : actor.type === 'user' ? 'user' : 'system', id: null, name: actor.name },
      action: 'place_draft',
      tier: 2,
      target: { kind: 'thread', id: row.gmail_thread_id, title: loaded.row.subject },
      summary: `Placed a ${row.kind.replace('_', '-')} draft in Gmail (not sent)`,
      policy,
      reversible: true,
      undo: { op: 'delete_gmail_draft', gmailDraftId, draftId: row.id },
      accountId: row.mail_account_id,
      threadId: row.gmail_thread_id,
      idempotencyKey: `place:${request.idempotencyKey}`,
    });
    return (await loadDraftById(tx, deps.box, userId, row.id, deps.now()))!;
  });
}

/**
 * What happened to a draft. With `finalText`, learn structural preferences
 * (length, greeting, sign-off) from the edit; the text itself is not stored.
 */
export async function recordDraftFeedback(
  deps: IntelDeps,
  userId: string,
  request: { draftId: string; variantId?: string; outcome: 'used' | 'edited' | 'discarded' | 'sent'; finalText?: string },
): Promise<void> {
  await deps.db.asUser(userId, async (tx) => {
    await memoryState(deps,tx,userId,true);
    const row = await one<DraftRow>(tx, `select ${DRAFT_COLUMNS} from public.drafts d join public.threads t on t.id = d.thread_id where d.id = $1::uuid`, [request.draftId]);
    if (!row) throw new ApiError('not_found', 'That draft does not exist.');
    const status = request.outcome === 'edited' ? 'user_edited' : request.outcome === 'discarded' ? 'discarded' : request.outcome === 'sent' ? 'sent' : row.status === 'placed' ? 'placed' : 'ready';
    await tx.query(`update public.drafts set status = $2, updated_at = now() where id = $1::uuid`, [row.id, status]);
    const prefs = await loadPreferences(tx, userId);
    if (request.finalText && prefs.memory.enabled && prefs.memory.learnFromDraftEdits && prefs.autoDrafts.learnFromEdits && (request.outcome === 'edited' || request.outcome === 'sent')) {
      const variants = await readVariants(tx, deps.box, userId, row.id, row.current_version);
      const variant = variants.find((item) => item.id === request.variantId) ?? variants[0];
      if (variant) {
        const recipient = await one<{ from_email: string | null }>(
          tx,
          `select from_email from public.message_metadata where thread_id = $1::uuid and direction = 'inbound' order by internal_date desc limit 1`,
          [row.thread_id],
        );
        await learnFromEdit(tx, userId, { draft: variant.body, final: request.finalText.slice(0, 20_000), recipient: recipient?.from_email ?? null });
      }
    }
  });
}

/** Placeholders still present in text the user is about to send (used by the extension's pre-send check). */
export function unresolvedPlaceholders(text: string) {
  return findPlaceholders(text);
}

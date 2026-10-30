import { addBusinessDaysInZone, findPlaceholders, safeTimeZone, zonedParts, zonedTimeToUtc, nextLocalTime } from '@pigeonbox/shared';
import { buildTrackingPixelHtml } from '@pigeonbox/tracking';
import { iso, num, one, type SqlExecutor } from '../db/sql.js';
import { buildRawMessage, escapeHtml } from '../google/mime.js';
import { ApiError } from '../http.js';
import { enqueue, type JobRecord } from '../jobs/queue.js';
import { DeferJob, PermanentJobError, RetryLaterError, SkipJob } from '../jobs/runner.js';
import { randomToken, sha256Hex } from '../platform/crypto.js';
import { performAction } from './actions.js';
import { createApproval } from './approvals.js';
import { recordAudit } from './audit.js';
import type { IntelDeps } from './context.js';
import { loadAccount, requireFeature } from './google-access.js';
import { loadPreferences, minutesOf } from './preferences.js';

/**
 * Controlled sequences. Deliberately small:
 * - recipients are only people the user provides (no scraping or enrichment);
 * - suppression (unsubscribes, bounces, manual) is checked before every send;
 * - every step's batch is approved by the user with the exact content;
 * - replies stop the sequence for that person; bounces suppress the address;
 * - conservative daily limits, a sending window, and one-click unsubscribe.
 */

export type SequenceStepInput = { delayBusinessDays: number; subject: string; body: string; aiPersonalize: boolean };

type SequenceRow = { id: string; name: string; status: string; mail_account_id: string; daily_limit: number; window_start: string; window_end: string; stop_on_reply: boolean; track_opens: boolean; created_at: unknown; updated_at: unknown };

export async function listSequences(tx: SqlExecutor) {
  const rows = await tx.query<SequenceRow & { enrolled: number; active: number; replied: number; sent: number; pending: number }>(
    `select s.*, (select count(*)::int from public.sequence_enrollments e where e.sequence_id = s.id) as enrolled,
            (select count(*)::int from public.sequence_enrollments e where e.sequence_id = s.id and e.status = 'active') as active,
            (select count(*)::int from public.sequence_enrollments e where e.sequence_id = s.id and e.status = 'replied') as replied,
            (select count(*)::int from public.sequence_sends x join public.sequence_enrollments e on e.id = x.enrollment_id where e.sequence_id = s.id and x.status = 'sent') as sent,
            (select count(*)::int from public.sequence_sends x join public.sequence_enrollments e on e.id = x.enrollment_id where e.sequence_id = s.id and x.status = 'pending_approval') as pending
       from public.sequences s order by s.created_at desc`,
  );
  const out = [];
  for (const row of rows) {
    const steps = await tx.query<{ step_index: number; delay_business_days: number; subject_template: string; body_template: string; ai_personalize: boolean }>(
      `select step_index, delay_business_days, subject_template, body_template, ai_personalize from public.sequence_steps where sequence_id = $1::uuid order by step_index`,
      [row.id],
    );
    out.push({
      id: row.id,
      name: row.name,
      status: row.status,
      accountId: row.mail_account_id,
      dailyLimit: num(row.daily_limit),
      window: { start: row.window_start, end: row.window_end },
      stopOnReply: row.stop_on_reply,
      trackOpens: row.track_opens,
      steps: steps.map((step) => ({ delayBusinessDays: num(step.delay_business_days), subject: step.subject_template, body: step.body_template, aiPersonalize: step.ai_personalize })),
      counts: { enrolled: num(row.enrolled), active: num(row.active), replied: num(row.replied), sent: num(row.sent), pendingApproval: num(row.pending) },
      createdAt: iso(row.created_at),
    });
  }
  return out;
}

export async function saveSequence(
  deps: IntelDeps,
  tx: SqlExecutor,
  userId: string,
  input: { id?: string; name: string; accountId: string; dailyLimit: number; window: { start: string; end: string }; stopOnReply: boolean; trackOpens: boolean; steps: SequenceStepInput[] },
): Promise<string> {
  const account = await loadAccount(tx, input.accountId);
  if (!account) throw new ApiError('not_found', 'That Google account is not connected.');
  if (!input.steps.length || input.steps.length > 5) throw new ApiError('invalid_request', 'A sequence has one to five steps.');
  const dailyLimit = Math.max(1, Math.min(input.dailyLimit, deps.config.intel.sequenceDailyLimit));
  let id = input.id;
  if (id) {
    const current = await one<{ status: string }>(tx, `select status from public.sequences where id = $1::uuid`, [id]);
    if (!current) throw new ApiError('not_found', 'That sequence does not exist.');
    if (current.status === 'active') throw new ApiError('conflict', 'Pause the sequence before changing its steps.');
    await tx.query(
      `update public.sequences set name = $2, mail_account_id = $3::uuid, daily_limit = $4, window_start = $5, window_end = $6, stop_on_reply = $7, track_opens = $8, updated_at = now() where id = $1::uuid`,
      [id, input.name, input.accountId, dailyLimit, input.window.start, input.window.end, input.stopOnReply, input.trackOpens],
    );
    await tx.query(`delete from public.sequence_steps where sequence_id = $1::uuid`, [id]);
  } else {
    const row = await one<{ id: string }>(
      tx,
      `insert into public.sequences (user_id, mail_account_id, name, daily_limit, window_start, window_end, stop_on_reply, track_opens) values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8) returning id`,
      [userId, input.accountId, input.name, dailyLimit, input.window.start, input.window.end, input.stopOnReply, input.trackOpens],
    );
    id = row!.id;
  }
  for (const [index, step] of input.steps.entries()) {
    await tx.query(
      `insert into public.sequence_steps (sequence_id, user_id, step_index, delay_business_days, subject_template, body_template, ai_personalize) values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)`,
      [id, userId, index, index === 0 ? 0 : Math.max(1, step.delayBusinessDays), step.subject.slice(0, 500), step.body.slice(0, 10_000), step.aiPersonalize],
    );
  }
  return id!;
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export async function enroll(deps: IntelDeps, tx: SqlExecutor, userId: string, sequenceId: string, recipients: Array<{ email: string; fields: Record<string, string> }>) {
  const sequence = await one<{ id: string }>(tx, `select id from public.sequences where id = $1::uuid`, [sequenceId]);
  if (!sequence) throw new ApiError('not_found', 'That sequence does not exist.');
  let added = 0;
  let suppressed = 0;
  let invalid = 0;
  for (const recipient of recipients.slice(0, 500)) {
    const email = recipient.email.trim().toLowerCase();
    if (!EMAIL.test(email)) {
      invalid += 1;
      continue;
    }
    const blocked = await one(tx, `select 1 from public.suppressions where email_normalized = $1`, [email]);
    const id = crypto.randomUUID();
    const sealed = await deps.box.seal(JSON.stringify(recipient.fields ?? {}), { purpose: 'note', userId, recordId: `enrollment:${id}` });
    const rows = await tx.query(
      `insert into public.sequence_enrollments (id, sequence_id, user_id, email, merge_key_id, merge_iv, merge_ciphertext, status, stopped_reason)
       values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9) on conflict (sequence_id, email_normalized) do nothing returning id`,
      [id, sequenceId, userId, email, sealed.keyId, sealed.iv, sealed.ciphertext, blocked ? 'suppressed' : 'active', blocked ? 'On your suppression list' : null],
    );
    if (rows.length && blocked) suppressed += 1;
    else if (rows.length) added += 1;
  }
  return { added, suppressed, invalid };
}

/** Merge fields into a template. Missing fields become visible placeholders, never guesses. */
export function mergeTemplate(template: string, fields: Record<string, string>): string {
  return template.replace(/\{\s*([a-z_][a-z0-9_]{0,39})\s*\}/gi, (_whole, key: string) => {
    const value = fields[key.toLowerCase()] ?? fields[key];
    return value?.trim() ? value.trim() : `[${key.replace(/_/g, ' ').toUpperCase()} NEEDED]`;
  });
}

/**
 * Render a step for every due recipient and ask for approval of the batch.
 * The approval shows the first message in full and the complete recipient list.
 */
export async function prepareStepBatch(deps: IntelDeps, userId: string, sequenceId: string, stepIndex: number): Promise<{ approvalId: string | null; count: number; blocked: number }> {
  return deps.db.asUser(userId, async (tx) => {
    const sequence = await one<SequenceRow>(tx, `select * from public.sequences where id = $1::uuid`, [sequenceId]);
    if (!sequence) throw new ApiError('not_found', 'That sequence does not exist.');
    if (sequence.status !== 'active') return { approvalId: null, count: 0, blocked: 0 };
    const step = await one<{ subject_template: string; body_template: string }>(tx, `select subject_template, body_template from public.sequence_steps where sequence_id = $1::uuid and step_index = $2`, [sequenceId, stepIndex]);
    if (!step) {
      await tx.query(`update public.sequences set status = 'completed', updated_at = now() where id = $1::uuid and not exists (select 1 from public.sequence_enrollments where sequence_id = $1::uuid and status = 'active')`, [sequenceId]);
      return { approvalId: null, count: 0, blocked: 0 };
    }
    const due = await tx.query<{ id: string; email: string; merge_key_id: string; merge_iv: string; merge_ciphertext: string }>(
      `select e.id, e.email, e.merge_key_id, e.merge_iv, e.merge_ciphertext from public.sequence_enrollments e
        where e.sequence_id = $1::uuid and e.status = 'active' and e.current_step = $2 and (e.next_send_at is null or e.next_send_at <= $3::timestamptz)
          and not exists (select 1 from public.sequence_sends x where x.enrollment_id = e.id and x.step_index = $2)
          and not exists (select 1 from public.suppressions s where s.email_normalized = e.email_normalized)
        order by e.created_at limit 200`,
      [sequenceId, stepIndex, deps.now()],
    );
    if (!due.length) return { approvalId: null, count: 0, blocked: 0 };
    let first: { email: string; subject: string; body: string } | null = null;
    let blocked = 0;
    for (const enrollment of due) {
      const fields = JSON.parse(await deps.box.open({ keyId: enrollment.merge_key_id, iv: enrollment.merge_iv, ciphertext: enrollment.merge_ciphertext }, { purpose: 'note', userId, recordId: `enrollment:${enrollment.id}` })) as Record<string, string>;
      const subject = mergeTemplate(step.subject_template, fields);
      const body = mergeTemplate(step.body_template, fields);
      if (findPlaceholders(`${subject}\n${body}`).length) {
        // A message with an unfilled field is never sent; the user sees why.
        blocked += 1;
        await tx.query(`update public.sequence_enrollments set status = 'stopped', stopped_reason = 'Missing merge field' where id = $1::uuid`, [enrollment.id]);
        continue;
      }
      const sendId = crypto.randomUUID();
      const sealed = await deps.box.seal(JSON.stringify({ subject, body }), { purpose: 'draft', userId, recordId: `send:${sendId}` });
      await tx.query(
        `insert into public.sequence_sends (id, enrollment_id, user_id, step_index, status, content_key_id, content_iv, content_ciphertext) values ($1::uuid, $2::uuid, $3::uuid, $4, 'pending_approval', $5, $6, $7)`,
        [sendId, enrollment.id, userId, stepIndex, sealed.keyId, sealed.iv, sealed.ciphertext],
      );
      first ??= { email: enrollment.email, subject, body };
    }
    const count = due.length - blocked;
    if (!count || !first) return { approvalId: null, count: 0, blocked };
    const approval = await createApproval(tx, deps.box, {
      userId,
      kind: 'send_email',
      tier: 3,
      title: `Send step ${stepIndex + 1} of "${sequence.name}" to ${count} ${count === 1 ? 'person' : 'people'}`,
      why: `Sequence "${sequence.name}". Up to ${sequence.daily_limit} emails per day, ${sequence.window_start}–${sequence.window_end}. Replies and unsubscribes stop it for that person.`,
      sources: [],
      action: { kind: 'send_email', params: { sequenceId, stepIndex } },
      target: { accountId: sequence.mail_account_id, threadRowId: null, gmailThreadId: null, title: sequence.name },
      preview: { to: [first.email], subject: first.subject, body: first.body, count, change: `${count} individual emails (first shown); each recipient sees only their own` },
      responsible: { type: 'sequence', id: sequenceId, name: sequence.name },
      idempotencyKey: `sequence:${sequenceId}:step:${stepIndex}:${deps.now().toISOString().slice(0, 10)}`,
    });
    await tx.query(`update public.sequence_sends set approval_id = $1::uuid where approval_id is null and status = 'pending_approval' and step_index = $2 and enrollment_id in (select id from public.sequence_enrollments where sequence_id = $3::uuid)`, [approval.id, stepIndex, sequenceId]);
    return { approvalId: approval.id, count, blocked };
  });
}

export async function setSequenceStatus(deps: IntelDeps, userId: string, sequenceId: string, status: 'active' | 'paused' | 'stopped') {
  const prepared = await deps.db.asUser(userId, async (tx) => {
    const sequence = await one<SequenceRow>(tx, `select * from public.sequences where id = $1::uuid`, [sequenceId]);
    if (!sequence) throw new ApiError('not_found', 'That sequence does not exist.');
    if (status === 'active') {
      const account = await loadAccount(tx, sequence.mail_account_id);
      if (!account) throw new ApiError('conflict', 'Reconnect the Google account first.');
      try {
        requireFeature(account, 'send');
      } catch {
        throw new ApiError('forbidden', 'Sequences need the separate "Send mail" permission on this Google account. PigeonBox still asks you to approve every batch.');
      }
    }
    await tx.query(`update public.sequences set status = $2, updated_at = now() where id = $1::uuid`, [sequenceId, status]);
    if (status === 'stopped') await tx.query(`update public.sequence_enrollments set status = 'stopped', stopped_reason = 'Sequence stopped' where sequence_id = $1::uuid and status = 'active'`, [sequenceId]);
    await recordAudit(tx, { userId, actor: { type: 'user', id: userId, name: 'You' }, action: `sequence_${status}`, tier: 0, target: { kind: 'sequence', id: sequenceId, title: sequence.name }, summary: `${status === 'active' ? 'Started' : status === 'paused' ? 'Paused' : 'Stopped'} sequence "${sequence.name}"`, policy: { decision: 'allowed', reason: 'User request' } });
    return status === 'active';
  });
  return prepared ? prepareStepBatch(deps, userId, sequenceId, 0) : { approvalId: null, count: 0, blocked: 0 };
}

/** Approval of a batch: schedule each send inside the window, spaced out, within the daily limit. */
export async function scheduleApprovedBatch(deps: IntelDeps, userId: string, approvalId: string, sequenceId: string): Promise<number> {
  return deps.db.asUser(userId, async (tx) => {
    const sequence = await one<SequenceRow>(tx, `select * from public.sequences where id = $1::uuid`, [sequenceId]);
    if (!sequence || sequence.status !== 'active') return 0;
    const sends = await tx.query<{ id: string }>(`update public.sequence_sends set status = 'approved' where approval_id = $1::uuid and status = 'pending_approval' returning id`, [approvalId]);
    let at = deps.now().getTime();
    for (const [index, send] of sends.entries()) {
      at += (index === 0 ? 0 : 90 + Math.floor(Math.random() * 120)) * 1_000;
      await tx.query(`update public.sequence_sends set scheduled_for = $2::timestamptz where id = $1::uuid`, [send.id, new Date(at)]);
      await enqueue(tx, { kind: 'sequence.step', userId, accountId: sequence.mail_account_id, key: `sequence-send:${send.id}`, payload: { sendId: send.id }, runAt: new Date(at), maxAttempts: 4 });
    }
    return sends.length;
  });
}

function withinWindow(now: Date, timeZone: string, window: { start: string; end: string }, workdays: number[]): Date | null {
  const zone = safeTimeZone(timeZone);
  const p = zonedParts(now, zone);
  const minutes = p.hour * 60 + p.minute;
  const start = minutesOf(window.start);
  const end = minutesOf(window.end);
  if (workdays.includes(p.weekday) && minutes >= start.hour * 60 + start.minute && minutes < end.hour * 60 + end.minute) return null;
  return nextLocalTime(minutes >= end.hour * 60 + end.minute ? zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 23, minute: 59 }, zone) : now, start, zone, { businessDaysOnly: true, workdays });
}

/** One approved send. Re-checks everything, then sends through the Tier 3 path marked approved. */
export async function runSequenceSend(deps: IntelDeps, job: JobRecord): Promise<void> {
  const sendId = String(job.payload.sendId ?? '');
  if (!job.userId || !sendId) throw new SkipJob('missing_ids');
  const userId = job.userId;
  const loaded = await deps.db.asUser(userId, async (tx) => {
    const send = await one<{ id: string; status: string; step_index: number; enrollment_id: string; content_key_id: string; content_iv: string; content_ciphertext: string; approval_id: string | null; tracking_id: string | null }>(
      tx,
      `select id, status, step_index, enrollment_id, content_key_id, content_iv, content_ciphertext, approval_id, tracking_id from public.sequence_sends where id = $1::uuid`,
      [sendId],
    );
    if (!send) return null;
    const enrollment = await one<{ id: string; email: string; status: string; sequence_id: string; gmail_thread_id: string | null }>(tx, `select id, email, status, sequence_id, gmail_thread_id from public.sequence_enrollments where id = $1::uuid`, [send.enrollment_id]);
    const sequence = enrollment ? await one<SequenceRow>(tx, `select * from public.sequences where id = $1::uuid`, [enrollment.sequence_id]) : null;
    const approval = send.approval_id ? await one<{ status: string }>(tx, `select status from public.approvals where id = $1::uuid`, [send.approval_id]) : null;
    const suppressed = enrollment ? await one(tx, `select 1 from public.suppressions where email_normalized = lower($1)`, [enrollment.email]) : null;
    const sentToday = await one<{ n: number }>(tx, `select count(*)::int as n from public.sequence_sends where status = 'sent' and sent_at > now() - interval '24 hours'`);
    const prefs = await loadPreferences(tx, userId);
    const next = sequence ? await one<{ delay_business_days: number }>(tx, `select delay_business_days from public.sequence_steps where sequence_id = $1::uuid and step_index = $2`, [sequence.id, send.step_index + 1]) : null;
    // Later steps reply to the previous email so they stay in one conversation for the recipient too.
    const previous = enrollment
      ? await one<{ rfc822_message_id: string | null }>(
          tx,
          `select m.rfc822_message_id from public.sequence_sends x join public.message_metadata m on m.gmail_message_id = x.gmail_message_id
            where x.enrollment_id = $1::uuid and x.status = 'sent' order by x.sent_at desc limit 1`,
          [enrollment.id],
        )
      : null;
    return { send, enrollment, sequence, approval, suppressed, sentToday: num(sentToday?.n), prefs, next, inReplyTo: previous?.rfc822_message_id ?? null };
  });
  if (!loaded?.send || !loaded.enrollment || !loaded.sequence) throw new SkipJob('send_gone');
  const { send, enrollment, sequence, prefs } = loaded;
  if (send.status !== 'approved') throw new SkipJob(`status_${send.status}`);
  type Receipt = { gmailMessageId?: string; gmailThreadId?: string | null };
  const completed = await deps.db.asUser(userId, tx => one<{ undo: Receipt }>(tx,
    `select undo from public.audit_events where idempotency_key = $1`, [`action:sequence-send:${sendId}`]));
  const finalize = async (receipt: Receipt, trackingId: string | null) => {
    if (!receipt.gmailMessageId) throw new PermanentJobError('action_unconfirmed');
    if (trackingId) await deps.store.trackerStoreFor(userId).updateEmail(trackingId, {
      status: 'SENT', gmail_message_id: receipt.gmailMessageId, gmail_thread_id: receipt.gmailThreadId ?? null,
    });
    await deps.db.asUser(userId, async tx => {
      // One transaction and a conditional transition make retry/concurrent
      // recovery advance this enrollment and schedule its next step only once.
      const changed = await tx.query(`update public.sequence_sends set status = 'sent', sent_at = coalesce(sent_at,now()),
        gmail_message_id = $2, gmail_thread_id = $3, tracking_id = $4, error_code = null
        where id = $1::uuid and status = 'approved' returning id`, [sendId, receipt.gmailMessageId, receipt.gmailThreadId ?? null, trackingId]);
      if (!changed.length) return;
      const nextAt = loaded.next ? addBusinessDaysInZone(deps.now(), num(loaded.next.delay_business_days), prefs.timeZone, { workdays: prefs.workdays, at: minutesOf(sequence.window_start) }) : null;
      await tx.query(`update public.sequence_enrollments set last_sent_at = now(), current_step = greatest(current_step,$4), next_send_at = $2::timestamptz,
        status = case when $2::timestamptz is null and status = 'active' then 'completed' else status end,
        gmail_thread_id = coalesce(gmail_thread_id,$3) where id = $1::uuid`, [enrollment.id, nextAt, receipt.gmailThreadId ?? null, send.step_index + 1]);
      if (nextAt) await enqueue(tx, { kind: 'sequence.step', userId, accountId: sequence.mail_account_id,
        key: `sequence-batch:${sequence.id}:${send.step_index + 1}:${nextAt.toISOString().slice(0,10)}`,
        payload: { sequenceId: sequence.id, stepIndex: send.step_index + 1 }, runAt: nextAt, maxAttempts: 3 });
    });
  };
  // Gmail already accepted this message. Bookkeeping recovery must precede
  // sending-window, suppression and active-sequence checks, and never resend.
  if (completed) return finalize(completed.undo, send.tracking_id);
  const skip = async (reason: string) => {
    await deps.db.asUser(userId, (tx) => tx.query(`update public.sequence_sends set status = 'skipped', error_code = $2 where id = $1::uuid`, [sendId, reason]));
    throw new SkipJob(reason);
  };
  if (loaded.approval?.status !== 'approved' && loaded.approval?.status !== 'executed') await skip('not_approved');
  // Waiting (paused, daily limit, outside the window) never spends one of the send's attempts.
  if (sequence.status !== 'active') {
    if (sequence.status === 'paused') throw new DeferJob('sequence_paused', 3_600);
    await skip('sequence_stopped');
  }
  if (enrollment.status !== 'active') await skip(`enrollment_${enrollment.status}`);
  if (loaded.suppressed) await skip('suppressed');
  const limit = Math.min(num(sequence.daily_limit), deps.config.intel.sequenceDailyLimit);
  if (loaded.sentToday >= limit) throw new DeferJob('daily_limit', 3_600);
  const wait = withinWindow(deps.now(), prefs.timeZone, { start: sequence.window_start, end: sequence.window_end }, prefs.workdays);
  if (wait) throw new DeferJob('outside_window', Math.max(60, Math.round((wait.getTime() - deps.now().getTime()) / 1_000)));

  const prepared = await deps.db.asUser(userId, async tx => {
    const locked = await one<{ content_key_id: string; content_iv: string; content_ciphertext: string }>(tx,
      `select content_key_id,content_iv,content_ciphertext from public.sequence_sends where id = $1::uuid for update`, [sendId]);
    if (!locked) throw new SkipJob('send_gone');
    type Content = { subject: string; body: string; dispatch?: { raw: string; trackingId: string | null; preparedAt: string } };
    const content = JSON.parse(await deps.box.open({ keyId: locked.content_key_id, iv: locked.content_iv, ciphertext: locked.content_ciphertext },
      { purpose: 'draft', userId, recordId: `send:${sendId}` })) as Content;
    const account = await loadAccount(tx, sequence.mail_account_id);
    if (!content.dispatch) {
      const token = randomToken(18);
      const origin = (deps.config.apiBaseUrl ?? deps.config.publicAppUrl ?? '').replace(/\/+$/, '');
      const unsubscribeUrl = `${origin}/u/${token}`;
      const trackingId = sequence.track_opens && deps.config.intel.trackerBaseUrl ? `trk_${sendId.replace(/-/g,'')}` : null;
      const html = trackingId ? `<div>${escapeHtml(content.body).replace(/\n/g,'<br>')}</div><p style="color:#777;font-size:12px">Don't want these emails? <a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe</a></p>${buildTrackingPixelHtml(`${deps.config.intel.trackerBaseUrl}/open/${trackingId}`)}` : undefined;
      content.dispatch = { trackingId, preparedAt: deps.now().toISOString(), raw: buildRawMessage({
        to: [{ email: enrollment.email }], subject: content.subject,
        body: `${content.body}\n\n—\nDon't want these emails? Unsubscribe: ${unsubscribeUrl}`, html,
        inReplyTo: loaded.inReplyTo, references: loaded.inReplyTo,
        headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      }) };
      const sealed = await deps.box.seal(JSON.stringify(content), { purpose: 'draft', userId, recordId: `send:${sendId}` });
      await tx.query(`update public.sequence_sends set content_key_id = $2,content_iv = $3,content_ciphertext = $4,
        tracking_id = $5,unsubscribe_token_hash = $6 where id = $1::uuid`,
        [sendId,sealed.keyId,sealed.iv,sealed.ciphertext,trackingId,await sha256Hex(token)]);
    }
    return { ...content, dispatch: content.dispatch, sender: account?.email ?? '' };
  });
  const { raw, trackingId, preparedAt } = prepared.dispatch;
  if (trackingId) {
    const store = deps.store.trackerStoreFor(userId);
    if (!await store.getEmail(trackingId)) {
      try {
        await store.insertEmail({ tracking_id: trackingId, status: 'PENDING', subject: prepared.subject, sender: prepared.sender,
          recipients: [enrollment.email], gmail_thread_id: null, gmail_message_id: null, created_at: preparedAt, sent_at: preparedAt,
          first_opened_at: null,last_opened_at: null,open_count: 0,first_clicked_at: null,last_clicked_at: null,click_count: 0 });
      } catch (error) { if (!await store.getEmail(trackingId)) throw error; }
    }
  }
  const outcome = await performAction(deps, userId, {
    spec: { kind: 'send_email', params: { raw } },
    target: { accountId: sequence.mail_account_id, threadRowId: null, gmailThreadId: enrollment.gmail_thread_id, title: prepared.subject },
    actor: { type: 'sequence', id: sequence.id, name: sequence.name },
    userInitiated: false,
    approved: true,
    idempotencyKey: `sequence-send:${sendId}`,
  });
  if (outcome.errorCode) {
    await deps.db.asUser(userId, (tx) => tx.query(`update public.sequence_sends set error_code = $2 where id = $1::uuid`, [sendId, outcome.errorCode]));
    if (trackingId) await deps.store.trackerStoreFor(userId).updateEmail(trackingId, { status: 'FAILED' });
    if (/rate_limited|unavailable|network/.test(outcome.errorCode)) throw new RetryLaterError(outcome.errorCode, 600);
    await deps.db.asUser(userId, (tx) => tx.query(`update public.sequence_sends set status = 'failed' where id = $1::uuid`, [sendId]));
    throw new PermanentJobError(outcome.errorCode);
  }
  const receipt = outcome.result?.undo ?? (outcome.auditId ? (await deps.db.asUser(userId,
    tx => one<{ undo: Receipt }>(tx, `select undo from public.audit_events where id = $1::uuid`, [outcome.auditId])))?.undo : null);
  if (!receipt || typeof receipt.gmailMessageId !== 'string') throw new PermanentJobError('action_unconfirmed');
  await finalize(receipt as Receipt, trackingId);
}

/** `sequence.step` job: either one approved send, or a later step's batch that needs approval. */
export async function runSequenceJob(deps: IntelDeps, job: JobRecord): Promise<void> {
  if (job.payload.sendId) return runSequenceSend(deps, job);
  if (!job.userId) throw new SkipJob('missing_ids');
  await prepareStepBatch(deps, job.userId, String(job.payload.sequenceId ?? ''), Number(job.payload.stepIndex ?? 0));
}

/** Replies stop the sequence for that person; bounces also suppress the address. Called by sync. */
export async function recordSequenceActivity(tx: SqlExecutor, threadRowIds: string[]): Promise<void> {
  if (!threadRowIds.length) return;
  const rows = await tx.query<{ id: string; email: string; user_id: string; bounce: boolean }>(
    `select e.id, e.email_normalized as email, e.user_id,
            exists (select 1 from public.message_metadata m where m.thread_id = t.id and m.direction = 'inbound' and lower(split_part(m.from_email, '@', 1)) in ('mailer-daemon', 'postmaster')) as bounce
       from public.sequence_enrollments e join public.sequences s on s.id = e.sequence_id
       join public.threads t on t.gmail_thread_id = e.gmail_thread_id and t.mail_account_id = s.mail_account_id
      where t.id = any($1::uuid[]) and e.status = 'active' and s.stop_on_reply and t.last_inbound_at > coalesce(e.last_sent_at, e.created_at)`,
    [threadRowIds],
  );
  for (const row of rows) {
    await tx.query(`update public.sequence_enrollments set status = $2, stopped_reason = $3 where id = $1::uuid`, [row.id, row.bounce ? 'bounced' : 'replied', row.bounce ? 'The message bounced' : 'They replied']);
    if (row.bounce) {
      await tx.query(`insert into public.suppressions (user_id, email_normalized, reason) values ($1::uuid, $2, 'bounced') on conflict (user_id, email_normalized) do nothing`, [row.user_id, row.email]);
    }
  }
}

export async function unsubscribeByToken(deps: IntelDeps, token: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return false;
  const found = await deps.db.system(async (tx) => one<{ enrollment_id: string; user_id: string; sequence_id: string; email: string }>(tx, `select * from app.resolve_unsubscribe($1)`, [await sha256Hex(token)]));
  if (!found) return false;
  await deps.db.asUser(found.user_id, async (tx) => {
    await tx.query(`update public.sequence_enrollments set status = 'unsubscribed', stopped_reason = 'Unsubscribed' where email_normalized = $1`, [found.email]);
    await tx.query(`insert into public.suppressions (user_id, email_normalized, reason, source_sequence_id) values ($1::uuid, $2, 'unsubscribed', $3::uuid) on conflict (user_id, email_normalized) do update set reason = 'unsubscribed'`, [found.user_id, found.email, found.sequence_id]);
  });
  return true;
}

export async function listSuppressions(tx: SqlExecutor) {
  const rows = await tx.query<{ email_normalized: string; reason: string; created_at: unknown }>(`select email_normalized, reason, created_at from public.suppressions order by created_at desc limit 1000`);
  return rows.map((row) => ({ email: row.email_normalized, reason: row.reason, createdAt: iso(row.created_at) }));
}

export async function addSuppression(tx: SqlExecutor, userId: string, email: string) {
  await tx.query(`insert into public.suppressions (user_id, email_normalized, reason) values ($1::uuid, lower($2), 'manual') on conflict (user_id, email_normalized) do nothing`, [userId, email]);
  await tx.query(`update public.sequence_enrollments set status = 'suppressed', stopped_reason = 'Added to your suppression list' where email_normalized = lower($1) and status = 'active'`, [email]);
}

export async function removeSuppression(tx: SqlExecutor, email: string) {
  await tx.query(`delete from public.suppressions where email_normalized = lower($1) and reason = 'manual'`, [email]);
}


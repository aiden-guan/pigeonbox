import { memoryState } from './memory/store.js';
import { syncPhase, type ConnectionFeature, type MailAccount } from '@pigeonbox/api-contract';
import { iso, isoOrNull, num, one, type SqlExecutor } from '../db/sql.js';
import { GoogleApiError } from '../google/errors.js';
import { grantedFeatures, normalizeRequestedFeatures, scopesForFeatures } from '../google/scopes.js';
import { ApiError } from '../http.js';
import { enqueue } from '../jobs/queue.js';
import { randomToken, sha256Hex } from '../platform/crypto.js';
import { recordAudit } from './audit.js';
import type { IntelDeps } from './context.js';
import { accessTokenSource, gmailFor, loadAccount, type AccountRow } from './google-access.js';

/**
 * Cloud-only Google connections: incremental consent, encrypted credential
 * storage, status, pause/resume, resync and disconnect with revocation.
 */

const STATE_TTL_MS = 10 * 60_000;

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function requireGoogle(deps: IntelDeps) {
  if (!deps.google) throw new ApiError('not_configured', 'Google connections are not configured on this server.');
  return deps.google;
}

export async function startConnection(
  deps: IntelDeps,
  userId: string,
  request: { features: ConnectionFeature[]; accountId?: string; loginHint?: string; returnTo: 'extension' | 'web' },
): Promise<string> {
  const google = requireGoogle(deps);
  const state = randomToken(32);
  const stateHash = await sha256Hex(state);
  const verifier = randomToken(48);
  const sealed = await deps.box.seal(verifier, { purpose: 'oauth_verifier', userId, recordId: stateHash });

  const { features, forceConsent, loginHint } = await deps.db.asUser(userId, async (tx) => {
    let wanted = normalizeRequestedFeatures(request.features);
    let hint = request.loginHint;
    let consent = true;
    if (request.accountId) {
      const account = await loadAccount(tx, request.accountId);
      if (!account) throw new ApiError('not_found', 'That connection does not exist.');
      wanted = normalizeRequestedFeatures([...wanted, ...(account.features as ConnectionFeature[])]);
      hint = hint ?? account.email;
      const hasToken = await one(tx, `select 1 from public.encrypted_credentials where mail_account_id = $1::uuid`, [account.id]);
      // Incremental authorization keeps the existing grant; consent is only forced when there is no refresh token to extend.
      consent = !hasToken || account.status === 'needs_reauth';
    } else {
      const count = await one<{ n: number }>(tx, `select count(*)::int as n from public.mail_accounts where status <> 'disconnected'`);
      if (num(count?.n) >= deps.config.intel.maxMailAccounts) {
        throw new ApiError('conflict', `You can connect up to ${deps.config.intel.maxMailAccounts} Google accounts.`);
      }
    }
    await tx.query(
      `insert into public.oauth_states (state_hash, user_id, mail_account_id, features, return_to, verifier_key_id, verifier_iv, verifier_ciphertext, expires_at)
       values ($1, $2::uuid, $3::uuid, $4::text[], $5, $6, $7, $8, $9::timestamptz)`,
      [stateHash, userId, request.accountId ?? null, wanted, request.returnTo, sealed.keyId, sealed.iv, sealed.ciphertext, new Date(deps.now().getTime() + STATE_TTL_MS)],
    );
    return { features: wanted, forceConsent: consent, loginHint: hint };
  });

  return google.oauth.authorizationUrl({
    scopes: scopesForFeatures(features),
    state,
    codeChallenge: await pkceChallenge(verifier),
    loginHint,
    forceConsent,
  });
}

export type ConnectionOutcome = {
  userId: string;
  accountId: string;
  returnTo: 'extension' | 'web';
  missing: ConnectionFeature[];
};

/**
 * The browser returns from Google here. The state is single use and binds the
 * callback to the user and features that started it; it expires in 10 minutes.
 */
export async function completeConnection(deps: IntelDeps, params: { code: string; state: string }): Promise<ConnectionOutcome> {
  const google = requireGoogle(deps);
  const stateHash = await sha256Hex(params.state);
  const pending = await deps.db.system((tx) =>
    one<{
      user_id: string;
      mail_account_id: string | null;
      features: ConnectionFeature[];
      return_to: 'extension' | 'web';
      verifier_key_id: string;
      verifier_iv: string;
      verifier_ciphertext: string;
    }>(
      tx,
      `update public.oauth_states set consumed_at = now()
        where state_hash = $1 and consumed_at is null and expires_at > now()
        returning user_id, mail_account_id, features, return_to, verifier_key_id, verifier_iv, verifier_ciphertext`,
      [stateHash],
    ),
  );
  if (!pending) throw new ApiError('invalid_request', 'This connection link expired or was already used. Start again.');
  const userId = pending.user_id;
  const verifier = await deps.box.open(
    { keyId: pending.verifier_key_id, iv: pending.verifier_iv, ciphertext: pending.verifier_ciphertext },
    { purpose: 'oauth_verifier', userId, recordId: stateHash },
  );

  let tokens;
  try {
    tokens = await google.oauth.exchangeCode(params.code, verifier);
  } catch (error) {
    if (error instanceof GoogleApiError) throw new ApiError('invalid_request', 'Google did not accept the connection. Start again.');
    throw error;
  }
  if (!tokens.idToken) throw new ApiError('invalid_request', 'Google did not identify the account. Start again.');
  const identity = await google.oauth.identity(tokens.idToken).catch(() => {
    throw new ApiError('invalid_request', 'Google did not identify the account. Start again.');
  });
  if (!identity.emailVerified) throw new ApiError('forbidden', 'Google has not verified this account’s email address.');

  const outcome = await deps.db.asUser(userId, async (tx) => {
    const existing = await one<AccountRow & { has_token: boolean }>(
      tx,
      `select a.id, a.user_id, a.email, a.google_sub, a.status, a.features, a.display_name,
              exists (select 1 from public.encrypted_credentials c where c.mail_account_id = a.id) as has_token
         from public.mail_accounts a where a.google_sub = $1`,
      [identity.sub],
    );
    const wanted = normalizeRequestedFeatures([...pending.features, ...((existing?.features ?? []) as ConnectionFeature[])]);
    const features = grantedFeatures(tokens.scopes, wanted);
    const refreshToken = tokens.refreshToken;
    if (!refreshToken && !existing?.has_token) {
      throw new ApiError('invalid_request', 'Google did not grant offline access. Remove PigeonBox from your Google account permissions and connect again.');
    }
    if (!existing) {
      const count = await one<{ n: number }>(tx, `select count(*)::int as n from public.mail_accounts where status <> 'disconnected'`);
      if (num(count?.n) >= deps.config.intel.maxMailAccounts) throw new ApiError('conflict', 'You reached the maximum number of connected Google accounts.');
    }
    const account = await one<{ id: string }>(
      tx,
      `insert into public.mail_accounts (user_id, google_sub, email, display_name, status, features, scopes, connected_at, disconnected_at, last_error_code)
       values ($1::uuid, $2, $3, $4, 'active', $5::text[], $6::text[], now(), null, null)
       on conflict (user_id, google_sub) do update set
         email = excluded.email, display_name = excluded.display_name, status = 'active', features = excluded.features,
         scopes = excluded.scopes, disconnected_at = null, last_error_code = null, updated_at = now()
       returning id`,
      [userId, identity.sub, identity.email, identity.name, features, tokens.scopes],
    );
    const accountId = account!.id;
    if (refreshToken) {
      const sealed = await deps.box.seal(refreshToken, { purpose: 'google_refresh_token', userId, recordId: accountId });
      await tx.query(
        `insert into public.encrypted_credentials (user_id, mail_account_id, kind, key_id, iv, ciphertext)
         values ($1::uuid, $2::uuid, 'google_refresh_token', $3, $4, $5)
         on conflict (mail_account_id, kind) do update set key_id = excluded.key_id, iv = excluded.iv, ciphertext = excluded.ciphertext, rotated_at = now()`,
        [userId, accountId, sealed.keyId, sealed.iv, sealed.ciphertext],
      );
    }
    if (features.includes('mail_read')) {
      await tx.query(
        `insert into public.gmail_sync_state (mail_account_id, user_id, state) values ($1::uuid, $2::uuid, 'initializing')
         on conflict (mail_account_id) do update set state = case when public.gmail_sync_state.history_id is null then 'initializing' else 'catching_up' end,
           consecutive_failures = 0, last_error_code = null, updated_at = now()`,
        [accountId, userId],
      );
      const stamp = deps.now().toISOString();
      await enqueue(tx, { kind: 'gmail.watch', userId, accountId, key: `watch:${accountId}:connect:${stamp}` });
      const cursor = await one<{ history_id: string | null }>(tx, `select history_id::text from public.gmail_sync_state where mail_account_id = $1::uuid`, [accountId]);
      if (cursor?.history_id) await enqueue(tx, { kind: 'gmail.sync', userId, accountId, key: `sync:${accountId}:reconnect:${stamp}`, maxAttempts: 8 });
      else await enqueue(tx, { kind: 'gmail.recover', userId, accountId, key: `recover:${accountId}:connect:${stamp}`, payload: { reason: 'initial' }, maxAttempts: 8 });
    }
    await recordAudit(tx, {
      userId,
      actor: { type: 'user', id: userId, name: 'You' },
      action: 'connect_account',
      tier: 0,
      target: { kind: 'mail_account', id: accountId, title: identity.email },
      summary: `Connected ${identity.email} (${features.join(', ') || 'no features'})`,
      policy: { decision: 'allowed', reason: 'User granted access in Google consent' },
    });
    return { accountId, missing: pending.features.filter((feature) => !features.includes(feature)) };
  });

  deps.log('info', 'google account connected', { userId, accountId: outcome.accountId, count: outcome.missing.length });
  return { userId, accountId: outcome.accountId, returnTo: pending.return_to, missing: outcome.missing };
}

type AccountListRow = AccountRow & {
  connected_at: unknown;
  sync_state: string | null;
  last_sync_completed_at: unknown;
  last_push_at: unknown;
  watch_expires_at: unknown;
  sync_error: string | null;
  coverage_since: unknown;
  threads: number;
  backlog: number;
  sync_backlog: number;
  processing_backlog: number;
  last_error_code: string | null;
};

/** Only these jobs mean Gmail itself is not current. The watch renewal is maintenance, not sync. */
export const MAIL_SYNC_JOB_KINDS = ['gmail.sync', 'gmail.recover'] as const;
/** Post-sync AI review of a conversation. Never makes mail look out of date. */
export const PROCESSING_JOB_KINDS = ['thread.analyze'] as const;

export async function listAccounts(tx: SqlExecutor): Promise<MailAccount[]> {
  const rows = await tx.query<AccountListRow>(
    `select a.id, a.user_id, a.email, a.google_sub, a.status, a.features, a.display_name, a.connected_at, a.last_error_code,
            s.state as sync_state, s.last_sync_completed_at, s.last_push_at, s.watch_expires_at, s.last_error_code as sync_error, s.coverage_since,
            (select count(*)::int from public.threads t where t.mail_account_id = a.id) as threads,
            (select count(*)::int from public.jobs j where j.mail_account_id = a.id and j.status in ('queued', 'retrying', 'running')) as backlog,
            (select count(*)::int from public.jobs j where j.mail_account_id = a.id and j.status in ('queued', 'retrying', 'running')
                and j.kind = any($1::text[])) as sync_backlog,
            (select count(distinct coalesce(j.payload->>'threadId', j.id::text))::int from public.jobs j
              where j.mail_account_id = a.id and j.status in ('queued', 'retrying', 'running') and j.kind = any($2::text[])) as processing_backlog
       from public.mail_accounts a
       left join public.gmail_sync_state s on s.mail_account_id = a.id
      where a.status <> 'disconnected'
      order by a.connected_at`,
    [MAIL_SYNC_JOB_KINDS, PROCESSING_JOB_KINDS],
  );
  return rows.map((row) => withPhase({
    id: row.id,
    provider: 'google' as const,
    email: row.email,
    displayName: row.display_name,
    status: row.status as MailAccount['status'],
    features: row.features as ConnectionFeature[],
    sync: {
      state: row.status === 'paused' ? 'paused' : ((row.sync_state ?? 'initializing') as MailAccount['sync']['state']),
      lastSyncAt: isoOrNull(row.last_sync_completed_at),
      lastPushAt: isoOrNull(row.last_push_at),
      watchExpiresAt: isoOrNull(row.watch_expires_at),
      backlog: num(row.backlog),
      syncBacklog: num(row.sync_backlog),
      processingBacklog: num(row.processing_backlog),
      lastErrorCode: row.sync_error ?? row.last_error_code,
      coverageSince: isoOrNull(row.coverage_since),
      threadsTracked: num(row.threads),
    },
    connectedAt: iso(row.connected_at),
  }));
}

function withPhase(account: MailAccount): MailAccount {
  return { ...account, sync: { ...account.sync, phase: syncPhase(account) } };
}

export async function getAccountSummary(tx: SqlExecutor, accountId: string): Promise<MailAccount> {
  const account = (await listAccounts(tx)).find((item) => item.id === accountId);
  if (!account) throw new ApiError('not_found', 'That connection does not exist.');
  return account;
}

export async function setPaused(deps: IntelDeps, userId: string, accountId: string, paused: boolean): Promise<MailAccount> {
  return deps.db.asUser(userId, async (tx) => {
    const account = await loadAccount(tx, accountId);
    if (!account || account.status === 'disconnected') throw new ApiError('not_found', 'That connection does not exist.');
    if (paused && account.status === 'active') {
      await tx.query(`update public.mail_accounts set status = 'paused', updated_at = now() where id = $1::uuid`, [accountId]);
      await tx.query(`update public.gmail_sync_state set state = 'paused', updated_at = now() where mail_account_id = $1::uuid`, [accountId]);
    } else if (!paused && account.status === 'paused') {
      await tx.query(`update public.mail_accounts set status = 'active', updated_at = now() where id = $1::uuid`, [accountId]);
      await tx.query(`update public.gmail_sync_state set state = 'catching_up', updated_at = now() where mail_account_id = $1::uuid`, [accountId]);
      const stamp = deps.now().toISOString();
      await enqueue(tx, { kind: 'gmail.watch', userId, accountId, key: `watch:${accountId}:resume:${stamp}` });
      await enqueue(tx, { kind: 'gmail.sync', userId, accountId, key: `sync:${accountId}:resume:${stamp}`, maxAttempts: 8 });
    }
    await recordAudit(tx, {
      userId,
      actor: { type: 'user', id: userId, name: 'You' },
      action: paused ? 'pause_account' : 'resume_account',
      tier: 0,
      target: { kind: 'mail_account', id: accountId, title: account.email },
      summary: paused ? `Paused syncing ${account.email}` : `Resumed syncing ${account.email}`,
      policy: { decision: 'allowed', reason: 'User request' },
    });
    return getAccountSummary(tx, accountId);
  });
}

export async function requestResync(deps: IntelDeps, userId: string, accountId: string): Promise<MailAccount> {
  return deps.db.asUser(userId, async (tx) => {
    const account = await loadAccount(tx, accountId);
    if (!account || account.status === 'disconnected') throw new ApiError('not_found', 'That connection does not exist.');
    if (account.status !== 'active') throw new ApiError('conflict', 'Reconnect or resume this account first.');
    await tx.query(`update public.gmail_sync_state set state = 'recovering', updated_at = now() where mail_account_id = $1::uuid`, [accountId]);
    await enqueue(tx, {
      kind: 'gmail.recover',
      userId,
      accountId,
      key: `recover:${accountId}:manual:${deps.now().toISOString().slice(0, 16)}`,
      payload: { reason: 'manual' },
      maxAttempts: 8,
    });
    return getAccountSummary(tx, accountId);
  });
}

/**
 * Disconnect: stop the Gmail watch, revoke the grant at Google (unless another
 * PigeonBox account still uses the same Google account), delete credentials,
 * cancel queued work, and optionally delete everything synced.
 */
export async function disconnect(deps: IntelDeps, userId: string, accountId: string, deleteData: boolean): Promise<void> {
  const account = await deps.db.asUser(userId, (tx) => loadAccount(tx, accountId));
  if (!account) throw new ApiError('not_found', 'That connection does not exist.');

  const sealed = await deps.db.asUser(userId, (tx) =>
    one<{ key_id: string; iv: string; ciphertext: string }>(
      tx,
      `select key_id, iv, ciphertext from public.encrypted_credentials where mail_account_id = $1::uuid and kind = 'google_refresh_token'`,
      [accountId],
    ),
  );
  let revoked = false;
  if (sealed && deps.google) {
    try {
      if (account.features.includes('mail_read') && account.status === 'active') {
        await gmailFor(deps, account).stop().catch(() => undefined);
      }
      const shared = await deps.db.system((tx) =>
        one(tx, `select 1 from public.mail_accounts where google_sub = $1 and id <> $2::uuid and status <> 'disconnected'`, [account.google_sub, accountId]),
      );
      if (!shared) {
        const refreshToken = await deps.box.open(
          { keyId: sealed.key_id, iv: sealed.iv, ciphertext: sealed.ciphertext },
          { purpose: 'google_refresh_token', userId, recordId: accountId },
        );
        await deps.google.oauth.revoke(refreshToken);
        revoked = true;
      }
    } catch (error) {
      // Revocation is best effort; credentials are deleted regardless, so PigeonBox can no longer use them.
      deps.log('warn', 'google revoke failed', { userId, accountId, code: error instanceof GoogleApiError ? error.code : 'error' });
    }
  }
  accessTokenSource(deps, account).invalidate();
  await deps.db.system((tx) => tx.query('select app.cancel_account_jobs($1::uuid)', [accountId]));
  await deps.db.asUser(userId, async (tx) => {
    // Memory writes and disconnect serialize. Remove source-dependent excerpts
    // even when the user retains metadata, and preserve shared derived facts.
    await memoryState(deps,tx,userId,true);
    await tx.query(`delete from public.recall_chunks where mail_account_id = $1::uuid`, [accountId]);
    await tx.query(`delete from public.personal_memory_sources where mail_account_id = $1::uuid`, [accountId]);
    await tx.query(`update public.personal_memories set superseded_by = null where superseded_by in (
      select m.id from public.personal_memories m where not m.corrected and not exists(select 1 from public.personal_memory_sources s where s.memory_id = m.id))`);
    await tx.query(`delete from public.personal_memories m where not m.corrected and not exists(select 1 from public.personal_memory_sources s where s.memory_id = m.id)`);
    await tx.query(`delete from public.encrypted_credentials where mail_account_id = $1::uuid`, [accountId]);
    if (deleteData) {
      await tx.query(`delete from public.mail_accounts where id = $1::uuid`, [accountId]);
    } else {
      await tx.query(
        `update public.mail_accounts set status = 'disconnected', features = '{}', disconnected_at = now(), updated_at = now() where id = $1::uuid`,
        [accountId],
      );
      await tx.query(`update public.gmail_sync_state set state = 'paused', history_id = null, watch_expires_at = null, updated_at = now() where mail_account_id = $1::uuid`, [
        accountId,
      ]);
    }
    await recordAudit(tx, {
      userId,
      actor: { type: 'user', id: userId, name: 'You' },
      action: 'disconnect_account',
      tier: 0,
      target: { kind: 'mail_account', id: accountId, title: null },
      summary: deleteData ? 'Disconnected a Google account and deleted its synced data' : 'Disconnected a Google account',
      policy: { decision: 'allowed', reason: revoked ? 'Access revoked at Google' : 'Credentials deleted' },
    });
  });
  deps.log('info', 'google account disconnected', { userId, accountId });
}

/** Account deletion: disconnect every Google account first so grants are revoked, then the profile cascade removes the rest. */
export async function disconnectAll(deps: IntelDeps, userId: string): Promise<void> {
  const accounts = await deps.db.asUser(userId, (tx) => tx.query<{ id: string }>(`select id from public.mail_accounts`));
  for (const account of accounts) await disconnect(deps, userId, account.id, true);
}

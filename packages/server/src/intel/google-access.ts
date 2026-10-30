import type { ConnectionFeature } from '@pigeonbox/api-contract';
import { one, type SqlExecutor } from '../db/sql.js';
import { CalendarClient } from '../google/calendar.js';
import { GoogleApiError } from '../google/errors.js';
import { GmailClient, type AccessTokenSource } from '../google/gmail.js';
import { PermanentJobError, RetryLaterError } from '../jobs/runner.js';
import { notify } from './notifications.js';
import type { IntelDeps } from './context.js';

/**
 * Server-side Google access for one connected account. The refresh token is
 * decrypted only here, only for the owning user (inside their RLS scope),
 * and exchanged for a short-lived access token kept in isolate memory.
 */

export type AccountRow = {
  id: string;
  user_id: string;
  email: string;
  google_sub: string;
  status: string;
  features: string[];
  display_name: string | null;
};

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Test hook: forget cached access tokens. */
export function clearAccessTokenCache(): void {
  tokenCache.clear();
}

export class ConnectionUnavailableError extends Error {
  constructor(readonly code: 'not_connected' | 'needs_reauth' | 'missing_feature' | 'paused') {
    super(code);
    this.name = 'ConnectionUnavailableError';
  }
}

export async function loadAccount(tx: SqlExecutor, accountId: string): Promise<AccountRow | null> {
  return one<AccountRow>(
    tx,
    `select id, user_id, email, google_sub, status, features, display_name from public.mail_accounts where id = $1::uuid`,
    [accountId],
  );
}

/** Mark an account as needing the user to reconnect, and tell them. */
export async function markNeedsReauth(deps: IntelDeps, userId: string, accountId: string, code: string): Promise<void> {
  tokenCache.delete(accountId);
  await deps.db.asUser(userId, async (tx) => {
    await tx.query(
      `update public.mail_accounts set status = 'needs_reauth', last_error_code = $2, updated_at = now() where id = $1::uuid and status <> 'disconnected'`,
      [accountId, code],
    );
    await tx.query(`update public.gmail_sync_state set state = 'stalled', last_error_code = $2, updated_at = now() where mail_account_id = $1::uuid`, [accountId, code]);
    await notify(tx, {
      userId,
      kind: 'sync_problem',
      title: 'Reconnect your Google account',
      body: 'Your PigeonBox server lost access to this Google account. Reconnect it to resume syncing.',
      accountId,
      dedupeKey: `reauth:${accountId}:${new Date().toISOString().slice(0, 10)}`,
    });
  });
  deps.log('warn', 'google access lost', { userId, accountId, code });
}

export function accessTokenSource(deps: IntelDeps, account: Pick<AccountRow, 'id' | 'user_id'>): AccessTokenSource {
  return {
    invalidate: () => tokenCache.delete(account.id),
    async get() {
      const cached = tokenCache.get(account.id);
      if (cached && cached.expiresAt - 60_000 > deps.now().getTime()) return cached.token;
      if (!deps.google) throw new ConnectionUnavailableError('not_connected');
      const sealed = await deps.db.asUser(account.user_id, (tx) =>
        one<{ key_id: string; iv: string; ciphertext: string }>(
          tx,
          `select key_id, iv, ciphertext from public.encrypted_credentials where mail_account_id = $1::uuid and kind = 'google_refresh_token'`,
          [account.id],
        ),
      );
      if (!sealed) throw new ConnectionUnavailableError('not_connected');
      const refreshToken = await deps.box.open(
        { keyId: sealed.key_id, iv: sealed.iv, ciphertext: sealed.ciphertext },
        { purpose: 'google_refresh_token', userId: account.user_id, recordId: account.id },
      );
      try {
        deps.log('info', 'google credential refresh started', { userId: account.user_id, accountId: account.id });
        const tokens = await deps.google.oauth.refresh(refreshToken);
        deps.log('info', 'google credential refresh succeeded', { userId: account.user_id, accountId: account.id });
        tokenCache.set(account.id, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
        return tokens.accessToken;
      } catch (error) {
        if (error instanceof GoogleApiError && error.code === 'auth_revoked') {
          await markNeedsReauth(deps, account.user_id, account.id, 'auth_revoked');
          throw new ConnectionUnavailableError('needs_reauth');
        }
        throw error;
      }
    },
  };
}

export function gmailFor(deps: IntelDeps, account: Pick<AccountRow, 'id' | 'user_id'>): GmailClient {
  if (!deps.google) throw new ConnectionUnavailableError('not_connected');
  return new GmailClient(accessTokenSource(deps, account), deps.fetch, deps.google.endpoints.gmail);
}

export function calendarFor(deps: IntelDeps, account: Pick<AccountRow, 'id' | 'user_id'>): CalendarClient {
  if (!deps.google) throw new ConnectionUnavailableError('not_connected');
  return new CalendarClient(accessTokenSource(deps, account), deps.fetch, deps.google.endpoints.calendar);
}

export function requireFeature(account: AccountRow, feature: ConnectionFeature): void {
  if (account.status === 'needs_reauth') throw new ConnectionUnavailableError('needs_reauth');
  if (account.status === 'paused') throw new ConnectionUnavailableError('paused');
  if (account.status !== 'active') throw new ConnectionUnavailableError('not_connected');
  if (!account.features.includes(feature)) throw new ConnectionUnavailableError('missing_feature');
}

/** Translate Google and connection failures into job outcomes. */
export function jobErrorFrom(error: unknown): unknown {
  if (error instanceof ConnectionUnavailableError) return new PermanentJobError(`connection_${error.code}`);
  if (error instanceof GoogleApiError) {
    if (error.retryable) return new RetryLaterError(`google_${error.code}`, error.retryAfterSeconds ?? 30);
    if (error.code === 'auth_revoked' || error.code === 'insufficient_permission') return new PermanentJobError(`google_${error.code}`);
    return new PermanentJobError(`google_${error.code}`);
  }
  return error;
}

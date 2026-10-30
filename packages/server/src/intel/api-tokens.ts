import { iso, isoOrNull, one, type SqlExecutor } from '../db/sql.js';
import { ApiError } from '../http.js';
import { randomToken, sha256Hex } from '../platform/crypto.js';
import { recordAudit } from './audit.js';
import type { IntelDeps } from './context.js';

/**
 * Developer API and MCP tokens. A token is shown once; only its SHA-256 is
 * stored. Scopes are `read` (look), `prepare` (create PigeonBox-internal
 * drafts, reminders, prepared events) and `write` (change the mailbox or
 * calendar). Nothing a token does bypasses the approval policy: sending is
 * never a token scope.
 */

export type Scope = 'read' | 'prepare' | 'write';
export const TOKEN_PREFIX = 'pbx_';

export async function createToken(tx: SqlExecutor, userId: string, input: { name: string; scopes: Scope[]; expiresInDays: number | null }) {
  const secret = `${TOKEN_PREFIX}${randomToken(32)}`;
  const scopes = [...new Set(input.scopes)];
  if (!scopes.length) throw new ApiError('invalid_request', 'Choose at least one scope.');
  const expires = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;
  const row = await one<{ id: string; created_at: unknown }>(
    tx,
    `insert into public.mcp_clients (user_id, name, token_prefix, token_hash, scopes, expires_at) values ($1::uuid, $2, $3, $4, $5::text[], $6::timestamptz) returning id, created_at`,
    [userId, input.name.slice(0, 120), secret.slice(0, 10), await sha256Hex(secret), scopes, expires],
  );
  await recordAudit(tx, { userId, actor: { type: 'user', id: userId, name: 'You' }, action: 'create_api_token', tier: 0, target: { kind: 'api_token', id: row!.id, title: input.name }, summary: `Created API token "${input.name}" (${scopes.join(', ')})`, policy: { decision: 'allowed', reason: 'User request' } });
  return { id: row!.id, token: secret, name: input.name, scopes, prefix: secret.slice(0, 10), expiresAt: isoOrNull(expires), createdAt: iso(row!.created_at) };
}

export async function listTokens(tx: SqlExecutor) {
  const rows = await tx.query<{ id: string; name: string; token_prefix: string; scopes: Scope[]; last_used_at: unknown; expires_at: unknown; revoked_at: unknown; created_at: unknown }>(
    `select id, name, token_prefix, scopes, last_used_at, expires_at, revoked_at, created_at from public.mcp_clients order by created_at desc`,
  );
  return rows.map((row) => ({ id: row.id, name: row.name, prefix: row.token_prefix, scopes: row.scopes, lastUsedAt: isoOrNull(row.last_used_at), expiresAt: isoOrNull(row.expires_at), revokedAt: isoOrNull(row.revoked_at), createdAt: iso(row.created_at) }));
}

export async function revokeToken(tx: SqlExecutor, userId: string, id: string): Promise<void> {
  const row = await one<{ name: string }>(tx, `update public.mcp_clients set revoked_at = coalesce(revoked_at, now()) where id = $1::uuid returning name`, [id]);
  if (!row) throw new ApiError('not_found', 'That token does not exist.');
  await recordAudit(tx, { userId, actor: { type: 'user', id: userId, name: 'You' }, action: 'revoke_api_token', tier: 0, target: { kind: 'api_token', id, title: row.name }, summary: `Revoked API token "${row.name}"`, policy: { decision: 'allowed', reason: 'User request' } });
}

/** Resolve a bearer token. System scope by hash only; everything afterwards runs as the owner. */
export async function resolveToken(deps: IntelDeps, token: string): Promise<{ clientId: string; userId: string; scopes: Scope[] } | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 128) return null;
  const hash = await sha256Hex(token);
  const row = await deps.db.system((tx) => one<{ client_id: string; user_id: string; scopes: Scope[] }>(tx, `select * from app.resolve_api_token($1)`, [hash]));
  return row ? { clientId: row.client_id, userId: row.user_id, scopes: row.scopes } : null;
}

/** Idempotent writes for API/MCP callers: the first result for a key is returned again. */
export async function withIdempotency<T extends Record<string, unknown>>(deps: IntelDeps, userId: string, scope: string, key: string, run: () => Promise<T>): Promise<T> {
  const existing = await deps.db.asUser(userId, (tx) => one<{ result: T }>(tx, `select result from public.idempotency_keys where scope = $1 and key = $2`, [scope, key]));
  if (existing) return existing.result;
  const result = await run();
  await deps.db.asUser(userId, (tx) =>
    tx.query(`insert into public.idempotency_keys (user_id, scope, key, result) values ($1::uuid, $2, $3, $4::jsonb) on conflict do nothing`, [userId, scope, key, JSON.stringify(result)]),
  );
  return result;
}

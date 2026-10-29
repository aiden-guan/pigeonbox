import { one, type SqlExecutor } from '../db/sql.js';
import type { AccountRow } from './google-access.js';

/**
 * Gmail IDs arrive in several spellings: hex from the Gmail API and URLs,
 * `thread-f:<decimal>` and `#thread-f:` from InboxSDK. Normalize to the API's
 * lowercase hex.
 */
export function normalizeGmailId(value: string): string {
  const bare = value.trim().replace(/^#/, '').replace(/^(thread-f:|thread-a:|msg-f:|msg-a:)/i, '');
  if (/^\d{16,20}$/.test(bare)) {
    try {
      return BigInt(bare).toString(16);
    } catch {
      return bare.toLowerCase();
    }
  }
  return bare.toLowerCase();
}

/** The user's connected account for a mailbox address or ID. Null when the mailbox is not connected. */
export async function resolveAccount(tx: SqlExecutor, selector: { mailbox?: string; accountId?: string }): Promise<AccountRow | null> {
  const columns = 'id, user_id, email, google_sub, status, features, display_name';
  if (selector.accountId) {
    return one<AccountRow>(tx, `select ${columns} from public.mail_accounts where id = $1::uuid and status <> 'disconnected'`, [selector.accountId]);
  }
  if (selector.mailbox) {
    return one<AccountRow>(tx, `select ${columns} from public.mail_accounts where email_normalized = lower($1) and status <> 'disconnected' order by connected_at limit 1`, [
      selector.mailbox,
    ]);
  }
  return one<AccountRow>(tx, `select ${columns} from public.mail_accounts where status <> 'disconnected' order by connected_at limit 1`);
}

export async function threadRowId(tx: SqlExecutor, accountId: string, gmailThreadId: string): Promise<string | null> {
  const row = await one<{ id: string }>(tx, `select id from public.threads where mail_account_id = $1::uuid and gmail_thread_id = $2`, [accountId, normalizeGmailId(gmailThreadId)]);
  return row?.id ?? null;
}

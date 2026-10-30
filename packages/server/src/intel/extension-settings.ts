import { iso, one, type SqlExecutor } from '../db/sql.js';

/** The extension's settings as saved to the account; restored after a reinstall. */
export type ExtensionSettingsBackup = { settings: Record<string, unknown>; rules: string[] | null; updatedAt: string };

type Row = { settings: Record<string, unknown>; rules: string[] | null; updated_at: Date | string };

const backup = (row: Row): ExtensionSettingsBackup => ({ settings: row.settings ?? {}, rules: row.rules ?? null, updatedAt: iso(row.updated_at) });

export async function loadExtensionSettings(tx: SqlExecutor, userId: string): Promise<ExtensionSettingsBackup | null> {
  const row = await one<Row>(tx, `select settings, rules, updated_at from public.extension_settings_backups where user_id = $1::uuid`, [userId]);
  return row ? backup(row) : null;
}

/** Save a snapshot (`replace`) or merge changed settings over the saved ones. Rules are replaced when given. */
export async function saveExtensionSettings(
  tx: SqlExecutor,
  userId: string,
  input: { settings: Record<string, unknown>; rules?: string[]; replace: boolean },
): Promise<ExtensionSettingsBackup> {
  const row = await one<Row>(
    tx,
    `insert into public.extension_settings_backups as b (user_id, settings, rules, updated_at)
     values ($1::uuid, $2::jsonb, $3::jsonb, now())
     on conflict (user_id) do update set
       settings = case when $4::boolean then excluded.settings else b.settings || excluded.settings end,
       rules = coalesce(excluded.rules, b.rules),
       updated_at = now()
     returning settings, rules, updated_at`,
    [userId, input.settings, input.rules === undefined ? null : JSON.stringify(input.rules), input.replace],
  );
  return backup(row!);
}

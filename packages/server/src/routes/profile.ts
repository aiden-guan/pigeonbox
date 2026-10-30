import type { DatabaseProvider } from '../db/sql.js';
import type { IntelDeps } from '../intel/context.js';

/** Users whose profile row is known to exist, per database (a Worker isolate talks to one). */
const ensured = new WeakMap<DatabaseProvider, Set<string>>();

function cacheFor(provider: DatabaseProvider): Set<string> {
  let set = ensured.get(provider);
  if (!set) {
    set = new Set();
    ensured.set(provider, set);
  }
  return set;
}

/**
 * Make sure the profile row exists in the intelligence database. In
 * production Supabase creates it on sign-up; development auth (never allowed
 * in production) also needs the `auth.users` row the profile references.
 */
export async function ensureSqlProfile(provider: DatabaseProvider, intel: IntelDeps, user: { userId: string; email: string | null }, development: boolean): Promise<void> {
  const cache = cacheFor(provider);
  if (cache.has(user.userId)) return;
  await intel.db.system(async (tx) => {
    if (development) await tx.query('insert into auth.users (id, email) values ($1::uuid, $2) on conflict (id) do nothing', [user.userId, user.email]);
    await tx.query('insert into public.profiles (id, email) values ($1::uuid, $2) on conflict (id) do nothing', [user.userId, user.email]);
  });
  cache.add(user.userId);
}

export function forgetProfile(provider: DatabaseProvider, userId: string): void {
  cacheFor(provider).delete(userId);
}

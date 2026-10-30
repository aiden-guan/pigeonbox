/** Explicit administrator repair. Does not print tracking IDs or mailbox metadata. */
import { createClient } from '@supabase/supabase-js';
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supply the intended database URL and service-role credential.');
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
let cursor = '';
let processed = 0;
let repaired = 0;
for (let batches = 0; batches < 1000; batches++) {
  const { data, error } = await db.rpc('reconcile_tracking_stats_batch', { p_after: cursor, p_limit: 25 });
  if (error) throw new Error('Tracking reconciliation failed; rerun safely after correcting the database fault.');
  processed += data.processed;
  repaired += data.repaired;
  console.log(JSON.stringify({ processed, repaired, complete: !data.hasMore }));
  if (!data.hasMore) break;
  if (data.cursor === cursor) throw new Error('Tracking reconciliation did not advance.');
  cursor = data.cursor;
  if (batches === 999) throw new Error('Tracking reconciliation reached its bounded work budget.');
}

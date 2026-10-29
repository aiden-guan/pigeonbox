import { describe, expect, it } from 'vitest';
import { connectedUser, createIntelHarness } from '../../testing/intel-harness.js';
import { openIntel } from '../../routes/jobs.js';
import { memoryState } from './store.js';

describe('canonical memory state loading', () => {
  it('initializes once, preserves the key on warm reads and retains requested row locks', async () => {
    const h = await createIntelHarness();
    try {
      const user = await connectedUser(h, 'state@work.test', ['mail_read'], { autoDrafts: { enabled: false } });
      const deps = openIntel(h.deps)!;
      const cold = await h.db.asUser(user.userId, tx => memoryState(deps, tx, user.userId));
      const queries: string[] = [];
      const warm = await h.db.asUser(user.userId, tx => memoryState(deps, { query: (sql, params) => {
        queries.push(sql); return tx.query(sql, params);
      } }, user.userId, true));
      expect(warm).toEqual(cold);
      expect(queries).toHaveLength(1);
      expect(queries[0]).toContain('for update');
      expect(await h.sql('select user_id from public.personal_memory_state')).toHaveLength(1);
      const other = await connectedUser(h, 'otherstate@work.test', ['mail_read'], { autoDrafts: { enabled: false } });
      expect(await h.db.asUser(other.userId, tx => tx.query('select user_id from public.personal_memory_state'))).toEqual([]);
    } finally { await h.pg.close(); }
  });
});

/** Read-only with respect to production. Verify repaired tracking invariants over the real handler and an isolated store. */
import assert from 'node:assert/strict';
import { createMemoryState, createMemoryStore, handleTrackerRequest, StoreError, processTrackingEvent } from '../../workers/tracker/src/index.ts';

const origin = 'https://tracker.audit.test';
const browser = 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36';
async function fixture() {
  const state = createMemoryState(); const store = createMemoryStore(state);
  const deps = { publicStore: store, authorize: async () => ({ store }), ipSalt: 'audit-only' };
  const call = (path, method = 'GET', body) => handleTrackerRequest(new Request(origin + path, {
    method, headers: { 'User-Agent': browser, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), deps);
  const email = await (await call('/api/emails', 'POST', { subject: 'Audit fixture', sender: 'sender@example.test', recipients: ['recipient@example.test'], links: [{ url: 'https://example.test/report' }] })).json();
  await call(`/api/emails/${email.tracking_id}`, 'PATCH', { status: 'SENT', sent_at: new Date(Date.now() - 60_000).toISOString() });
  return { state, store, deps, call, id: email.tracking_id, click: new URL(email.rewritten_links[0].tracked_url).pathname };
}

const race = await fixture();
await Promise.all([race.call(race.click), race.call(race.click)]);
assert.equal(race.state.events.filter(event => event.type === 'CLICK').length, 2);
assert.equal((await race.store.getEmail(race.id)).click_count, 2);
console.log('PASS concurrent memory-store requests retain both clicks. Native Postgres lock tests run separately.');

const outage = await fixture(); const queued = [];
outage.deps.enqueueEvent = async event => { queued.push(event); };
const insert = outage.store.insertEvent.bind(outage.store);
outage.store.insertEvent = async () => { throw new StoreError('simulated outage'); };
assert.equal((await outage.call(outage.click)).status, 302);
assert.equal(outage.state.events.length, 0);assert.equal(queued.length, 1);
outage.store.insertEvent = insert;
await processTrackingEvent(queued[0],outage.store);await processTrackingEvent(queued[0],outage.store);
assert.equal(outage.state.events.length,1);
assert.equal((await outage.store.getEmail(outage.id)).click_count,1);
console.log('PASS accepted queue envelope survives the database outage and replays once.');

const busy = await fixture();
for (let i = 0; i < 5001; i++) await busy.store.insertEvent({
  id: `evt_${i}`, tracking_id: busy.id, type: 'CLICK', timestamp: new Date(Date.now() - 50_000 + i).toISOString(),
  user_agent: browser, ip_hash: null, suspected_self_open: false, confidence: 0.8, classification: 'RECIPIENT_LIKELY',
});
await busy.call(busy.click);
assert.equal(busy.state.events.length, 5002);
assert.equal((await busy.store.getEmail(busy.id)).click_count, 5002);
console.log('PASS complete lifetime total: 5,002 recorded clicks, persisted click_count = 5,002.');

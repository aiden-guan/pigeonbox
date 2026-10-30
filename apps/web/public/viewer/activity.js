/** Minimal same-origin delivery journal. No document bytes, email addresses, or account tokens. */
export class DocumentActivityJournal {
  constructor({ storage, scope, wallNow = () => Date.now() }) {
    Object.assign(this, { storage, wallNow });
    this.prefix = `pigeonbox.document-activity:${scope}:`;
  }
  valid(value) {
    return value && value.version === 1 && typeof value.session?.sessionId === 'string' &&
      /^[A-Za-z0-9_-]{32}$/.test(value.session.sessionToken) &&
      Number.isFinite(Date.parse(value.session.expiresAt)) && Date.parse(value.session.expiresAt) > this.wallNow() &&
      Date.parse(value.session.expiresAt) <= this.wallNow() + 8 * 3600_000 + 60_000 &&
      Array.isArray(value.queue) && value.queue.length <= 500 && value.queue.every(event =>
        typeof event.id === 'string' && event.id.length <= 100 && ['view_start','page_view','heartbeat','view_end'].includes(event.kind) &&
        (event.page == null || (Number.isInteger(event.page) && event.page > 0 && event.page <= 500)) &&
        (event.visibleMs === undefined || (Number.isInteger(event.visibleMs) && event.visibleMs >= 0 && event.visibleMs <= 30_000))) &&
      Array.isArray(value.seen) && value.seen.length <= 500 && value.seen.every(page => Number.isInteger(page) && page > 0 && page <= 500) &&
      typeof value.started === 'boolean';
  }
  entries() {
    const entries = []; this.total = 0;
    for (let index = 0; index < this.storage.length; index++) {
      const key = this.storage.key(index);
      if (!key?.startsWith('pigeonbox.document-activity:')) continue;
      try { const value = JSON.parse(this.storage.getItem(key));
        if (this.valid(value)) { this.total++; if (key.startsWith(this.prefix)) entries.push(value); }
        else { this.storage.removeItem(key); index--; }
      } catch { this.storage.removeItem(key); index--; }
    }
    return entries.sort((a,b) => Date.parse(b.session.expiresAt) - Date.parse(a.session.expiresAt));
  }
  latest() { return this.entries()[0] ?? null; }
  entry(sessionId) {
    const value = JSON.parse(this.storage.getItem(this.prefix + sessionId) || 'null');
    return this.valid(value) ? value : null;
  }
  acknowledge(session, ids) {
    const value = this.entry(session.sessionId);
    if (!value || value.session.sessionToken !== session.sessionToken) return;
    this.write(session, { queue: value.queue.filter(event => !ids.has(event.id)), seen: value.seen, started: value.started });
  }
  read(session) {
    const value = JSON.parse(this.storage.getItem(this.prefix + session.sessionId) || 'null');
    return this.valid(value) && value.session.sessionToken === session.sessionToken ? value : null;
  }
  write(session, state) {
    const key = this.prefix + session.sessionId;
    if (!this.storage.getItem(key)) { this.entries(); if (this.total >= 20) throw new Error('Activity journal is full'); }
    const value = { version: 1,
      session: { sessionId: session.sessionId, sessionToken: session.sessionToken, expiresAt: session.expiresAt, preview: session.preview === true },
      queue: state.queue.map(event => ({ id: event.id, kind: event.kind, ...(event.page !== undefined ? { page: event.page } : {}), ...(event.visibleMs !== undefined ? { visibleMs: event.visibleMs } : {}) })),
      seen: state.seen, started: state.started === true };

    if (!this.valid(value)) throw new Error('Activity journal unavailable');
    this.storage.setItem(key, JSON.stringify(value));
  }
  remove(session) { this.storage.removeItem(this.prefix + session.sessionId); }
}

/** Activity is an observation, never proof of identity or reading. */
export class DocumentActivity {
  constructor({ session, send, attentive, onFailure = () => {}, now = () => performance.now(), journal = null }) {
    Object.assign(this, { session, send, attentive, onFailure, now, journal });
    this.queue = []; this.seen = new Set(); this.sequence = 0; this.eventPrefix = crypto.randomUUID();
    this.current = null; this.pendingMs = 0; this.lastTick = now();
    this.started = false; this.stopped = false; this.inFlight = null;
    try { const saved = journal?.read(session);
      if (saved) { this.queue = saved.queue; this.seen = new Set(saved.seen); this.started = saved.started; }
    } catch { this.onFailure(); }
  }
  persist() {
    try { this.journal?.write(this.session, { queue: this.queue, seen: [...this.seen], started: this.started }); }
    catch { this.onFailure(); }
  }
  record(kind, extra = {}) {
    if (this.stopped) return false;
    if (this.queue.length >= 500) { this.current = null; this.pendingMs = 0; this.onFailure(); return false; }
    this.queue.push({ id: `event-${this.eventPrefix}-${(this.sequence++).toString(36)}`, kind, ...extra });
    this.persist(); return true;
  }
  tick() {
    const now = this.now(); const elapsed = now - this.lastTick; this.lastTick = now;
    if (this.attentive() && this.current !== null && elapsed >= 0 && elapsed <= 2000) this.pendingMs += elapsed;
  }
  settle(kind = 'heartbeat') {
    this.tick();
    const visibleMs = Math.round(Math.min(this.pendingMs, 30_000)); this.pendingMs = 0;
    if (this.started && (visibleMs > 0 || kind === 'view_end')) this.record(kind, { page: this.current, visibleMs });
  }
  page(page) {
    const next = this.attentive() ? page : null;
    if (next === this.current) return;
    this.settle(); this.current = next; this.lastTick = this.now();
    if (next !== null && !this.started) { this.started = true; if (!this.record('view_start')) this.started = false; }
    if (next !== null && this.started && !this.seen.has(next)) { this.seen.add(next); if (!this.record('page_view', { page: next })) this.seen.delete(next); }
    if (next !== null) void this.flush();
  }
  pause(kind = 'heartbeat') { this.settle(kind); this.current = null; this.lastTick = this.now(); }
  stop() { this.stopped = true; this.queue = []; this.current = null; this.pendingMs = 0; try { this.journal?.remove(this.session); } catch { /* Expiry also removes abandoned journals. */ } }
  async flush(final = false) {
    if (!this.queue.length || (this.inFlight && !final)) return;
    const task = (async () => {
      // Drain an offline backlog when connectivity returns. Each batch is
      // ordered and bounded; retries keep their original event identities.
      for (let batches = 0; batches < 10 && this.queue.length; batches++) {
        const batch = this.queue.slice(0, 50);
        const payload = { sessionId: this.session.sessionId, sessionToken: this.session.sessionToken, events: batch };
        try {
          await this.send(payload);
          const ids = new Set(batch.map(event => event.id));
          this.queue = this.queue.filter(event => !ids.has(event.id));
          if (!this.stopped) {
            try { this.journal?.acknowledge(this.session, ids); } catch { this.onFailure(); }
          }
        } catch { this.onFailure(); break; }
      }
    })();
    this.inFlight = task; await task;
    if (this.inFlight === task) this.inFlight = null;
  }
}

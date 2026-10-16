/** Durable, account-scoped acknowledgements. No credentials are stored here. */
type Receipt<T> = { scope: string; key: string; revision: string; payload: T };
type Storage = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

export class TrackingReceipts<T> {
  private writes: Promise<unknown> = Promise.resolve();
  private deliveries: Promise<unknown> = Promise.resolve();

  constructor(private readonly storageKey: string, private readonly storage: () => Storage = () => chrome.storage.local) {}

  private async read(): Promise<Receipt<T>[]> {
    const value = (await this.storage().get(this.storageKey))[this.storageKey];
    return Array.isArray(value) ? value.filter(row => row && typeof row.scope === 'string' && typeof row.key === 'string' && typeof row.revision === 'string' && row.payload && typeof row.payload === 'object') : [];
  }

  private update(change: (rows: Receipt<T>[]) => Receipt<T>[]): Promise<void> {
    const task = this.writes.then(async () => {
      await this.storage().set({ [this.storageKey]: change(await this.read()) });
    });
    this.writes = task.catch(() => undefined);
    return task;
  }

  async save(scope: string, key: string, payload: T, merge?: (previous: T, next: T) => T): Promise<void> {
    await this.update(rows => {
      const previous = rows.find(row => row.scope === scope && row.key === key);
      if (!previous && rows.length >= 1000) throw new Error('Tracking receipt storage is full.');
      return [...rows.filter(row => row !== previous), {
        scope, key, revision: crypto.randomUUID(), payload: previous && merge ? merge(previous.payload, payload) : payload,
      }];
    });
  }

  async pending(scope: string): Promise<number> {
    await this.writes;
    return (await this.read()).filter(row => row.scope === scope).length;
  }

  /** Serialize delivery as well as storage: an old update cannot arrive after a newer send receipt. */
  flush(scope: string, send: (key: string, payload: T) => Promise<void>, key?: string): Promise<boolean> {
    const task = this.deliveries.then(async () => {
      await this.writes;
      const rows = (await this.read()).filter(row => row.scope === scope && (key === undefined || row.key === key)).slice(0, 4);
      let acknowledged = true;
      await Promise.all(rows.map(async row => {
        try {
          await send(row.key, row.payload);
          // A receipt can change while its earlier revision is in flight.
          await this.update(current => current.filter(item => item.revision !== row.revision));
        } catch {
          acknowledged = false;
          // Permanent failures must not starve later receipts on every poll.
          await this.update(current => {
            const pending = current.find(item => item.revision === row.revision);
            return pending ? [...current.filter(item => item !== pending), pending] : current;
          });
        }
      }));
      await this.writes;
      return acknowledged && !(await this.read()).some(row => row.scope === scope && (key === undefined || row.key === key));
    });
    this.deliveries = task.catch(() => undefined);
    return task;
  }
}

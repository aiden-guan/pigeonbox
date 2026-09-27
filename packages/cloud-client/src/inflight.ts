/**
 * Request de-duplication and a short-lived result cache for UI reads.
 *
 * Gmail asks for the same thread state from several places at once (chips,
 * the thread card, the side panel). Concurrent callers share one request, and
 * a result is reused for `ttlMs`. Failures are not cached.
 */
export class InflightCache<T> {
  private readonly pending = new Map<string, Promise<T>>();
  private readonly values = new Map<string, { value: T; at: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** A cached value that is still fresh, without starting a request. */
  peek(key: string): T | undefined {
    const hit = this.values.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.ttlMs) {
      this.values.delete(key);
      return undefined;
    }
    return hit.value;
  }

  get(key: string, load: () => Promise<T>): Promise<T> {
    const fresh = this.peek(key);
    if (fresh !== undefined) return Promise.resolve(fresh);
    const running = this.pending.get(key);
    if (running) return running;
    const promise = load()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  set(key: string, value: T): void {
    if (this.values.size >= this.maxEntries) {
      const oldest = this.values.keys().next().value;
      if (oldest !== undefined) this.values.delete(oldest);
    }
    this.values.set(key, { value, at: this.now() });
  }

  invalidate(key?: string): void {
    if (key === undefined) this.values.clear();
    else this.values.delete(key);
  }
}

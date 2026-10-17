/**
 * Tiny map with a time-to-live and a maximum size, used for tokens, resolved
 * stream URLs, client ids, search results, and other short lived data.
 */
export class TimedCache<K, V> {
  readonly #ttl: number;
  readonly #max: number;
  readonly #entries = new Map<K, { value: V; expires: number }>();

  constructor(ttlMs: number, max = 128) {
    this.#ttl = ttlMs;
    this.#max = Math.max(1, max);
  }

  get(key: K): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V, ttlMs = this.#ttl): V {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expires: Date.now() + ttlMs });
    this.#evict();
    return value;
  }

  /** Return the cached value, or compute and store it when missing. */
  async resolve(key: K, factory: () => Promise<V>, ttlMs = this.#ttl): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await factory();
    return this.set(key, value, ttlMs);
  }

  delete(key: K): boolean {
    return this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }

  #evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.#entries) {
      if (entry.expires > now) break;
      this.#entries.delete(key);
    }
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }
}

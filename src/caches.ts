export type CachedUser = {
  id: string;
  name: string;
  tz: string;
  latlng: [number, number] | null;
  isBot: boolean;
};

export class UserCache {
  private map = new Map<string, { user: CachedUser | null; loadedAt: number }>();
  constructor(
    private ttlMs: number,
    private fetcher: (id: string) => Promise<CachedUser | null>,
  ) {}

  async get(id: string): Promise<CachedUser | null> {
    const now = Date.now();
    const entry = this.map.get(id);
    if (entry && now - entry.loadedAt < this.ttlMs) return entry.user;
    const fresh = await this.fetcher(id);
    this.map.set(id, { user: fresh, loadedAt: now });
    return fresh;
  }

  prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, e] of this.map) if (e.loadedAt < cutoff) this.map.delete(id);
  }

  size(): number {
    return this.map.size;
  }
}

// Per-thread participant cache. Each entry is a Map<userId, lastSeenMs>.
// An author drops out of a thread when their lastSeen is older than ttlMs.
export class ThreadAuthorCache {
  private threads = new Map<string, Map<string, number>>();
  constructor(private ttlMs: number) {}

  record(key: string, userId: string, atMs: number): void {
    let m = this.threads.get(key);
    if (!m) {
      m = new Map();
      this.threads.set(key, m);
    }
    m.set(userId, atMs);
    this.pruneOne(key, m);
  }

  others(key: string, exceptUserId: string): string[] {
    const m = this.threads.get(key);
    if (!m) return [];
    const cutoff = Date.now() - this.ttlMs;
    const out: string[] = [];
    for (const [u, t] of m) {
      if (u !== exceptUserId && t >= cutoff) out.push(u);
    }
    return out;
  }

  pruneAll(): void {
    for (const [k, m] of this.threads) this.pruneOne(k, m);
  }

  private pruneOne(key: string, m: Map<string, number>): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [u, t] of m) if (t < cutoff) m.delete(u);
    if (m.size === 0) this.threads.delete(key);
  }

  stats(): { threads: number; authors: number } {
    let authors = 0;
    for (const m of this.threads.values()) authors += m.size;
    return { threads: this.threads.size, authors };
  }
}

import { fetchDishHistory } from './dishClient.js';
import type { DishSlot } from './types.js';

export type HistoryFetcher = (target: string, timeoutMs: number) => Promise<any>;

interface Entry {
  value?: any;
  fetchedAt: number;          // ms epoch of the last successful upstream fetch
  error?: string;
  errorAt: number;            // ms epoch of the last failed upstream fetch
  inflight?: Promise<void>;
  upstreamCalls: number;
}

export interface HistoryResult {
  history: any;
  fetchedAt: number;
  cached: boolean;
}

/**
 * Per-dish get_history cache with request coalescing. Every caller (the poller's sparkline refresh and the
 * /api/dish/:dish/history route) goes through here, so the dish sees at most one get_history per `maxAgeMs`
 * per dish however many clients ask. A failed fetch is remembered for `errorTtlMs` (away dish not hammered).
 */
export class HistoryCache {
  private entries = new Map<DishSlot, Entry>();
  constructor(
    private fetcher: HistoryFetcher = fetchDishHistory,
    private errorTtlMs = 10_000,
    private now: () => number = Date.now,
  ) {}

  private entry(slot: DishSlot): Entry {
    let e = this.entries.get(slot);
    if (!e) { e = { fetchedAt: 0, errorAt: 0, upstreamCalls: 0 }; this.entries.set(slot, e); }
    return e;
  }

  upstreamCalls(slot: DishSlot): number { return this.entries.get(slot)?.upstreamCalls ?? 0; }

  /** Cached value if fresher than maxAgeMs, else one (shared) upstream fetch. Throws on away/unreachable. */
  async get(slot: DishSlot, target: string, maxAgeMs: number, timeoutMs: number): Promise<HistoryResult> {
    const e = this.entry(slot);
    const t = this.now();
    if (e.value !== undefined && t - e.fetchedAt < maxAgeMs && e.fetchedAt >= e.errorAt) {
      return { history: e.value, fetchedAt: e.fetchedAt, cached: true };
    }
    if (e.error && t - e.errorAt < this.errorTtlMs && e.errorAt > e.fetchedAt) throw new Error(e.error);
    if (!e.inflight) {
      e.upstreamCalls++;
      e.inflight = this.fetcher(target, timeoutMs)
        .then((v) => { e.value = v; e.fetchedAt = this.now(); e.error = undefined; })
        .catch((err) => { e.error = String((err as Error)?.message || err).slice(0, 200); e.errorAt = this.now(); })
        .finally(() => { e.inflight = undefined; });
    }
    await e.inflight;
    if (e.errorAt > e.fetchedAt) throw new Error(e.error);
    return { history: e.value, fetchedAt: e.fetchedAt, cached: false };
  }

  /** Last good value regardless of age (for the sparkline). */
  peek(slot: DishSlot): { history: any; fetchedAt: number } | null {
    const e = this.entries.get(slot);
    return e?.value !== undefined ? { history: e.value, fetchedAt: e.fetchedAt } : null;
  }
}

/** Fixed-window limiter keyed by string (client+dish). */
export class RateLimiter {
  private hits = new Map<string, { start: number; n: number }>();
  constructor(private max: number, private windowMs: number, private now: () => number = Date.now) {}
  /** Returns 0 if allowed, else ms until the window resets. */
  take(key: string): number {
    const t = this.now();
    let h = this.hits.get(key);
    if (!h || t - h.start >= this.windowMs) { h = { start: t, n: 0 }; this.hits.set(key, h); }
    if (this.hits.size > 1000) for (const [k, v] of this.hits) if (t - v.start >= this.windowMs) this.hits.delete(k);
    if (h.n >= this.max) return h.start + this.windowMs - t;
    h.n++;
    return 0;
  }
}

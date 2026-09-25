// Result cache for the recommendation engine.
//
// Two kinds of state live here, and they are shared differently when there is
// more than one API instance (REDIS_URL set, see shared/kv.ts):
//
//   • Ranked results (recoCache). Kept in this process only: they hold live
//     ListingRecord references and Sets, are keyed by this process's own index
//     and snapshot versions, and are cheap to rebuild. What has to be shared is
//     invalidation, so a save on one server is not served stale by another.
//     Callers build keys with genKey(), which appends cluster-wide generation
//     numbers kept in the kv; invalidateParent()/invalidateAllResults() bump
//     them, and every instance's next lookup misses.
//   • Rids (ridStore / longRidStore): which listings a response served, plus
//     the ranked list "Show more" slices. Written through to the kv, so a
//     beacon, a "Show more" or an email click landing on another server still
//     resolves.
//
// Without REDIS_URL neither goes near the kv: the stores are the same bounded
// in-process LRUs as before and invalidation is the local prefix delete, so a
// single server behaves exactly as it always did. Every key is namespaced
// 'reco:v1:' so a schema change to what is cached only needs the version bumped.

import { logger } from '../../logger.js';
import { kv } from '../../shared/kv.js';
import { invalidateRecoConfig } from './config.js';

export interface CacheBackend {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlSec: number): void;
  del(key: string): void;
  delPrefix(prefix: string): void;
  incr(hash: string, field: string, n: number): number;
  /** Single-flight: concurrent misses for one key share one computation. */
  wrap<T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<T>;
}

const NS = 'reco:v1:';

interface Entry {
  value: unknown;
  expiresAt: number;
}

export class MemoryCache implements CacheBackend {
  private map = new Map<string, Entry>();
  private inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly max = 5000) {}

  get<T>(key: string): T | undefined {
    const k = NS + key;
    const e = this.map.get(k);
    if (!e) return undefined;
    if (e.expiresAt <= Date.now()) {
      this.map.delete(k);
      return undefined;
    }
    // Refresh recency: a Map iterates in insertion order, so re-inserting
    // moves the key to the "most recently used" end.
    this.map.delete(k);
    this.map.set(k, e);
    return e.value as T;
  }

  set<T>(key: string, value: T, ttlSec: number): void {
    const k = NS + key;
    this.map.delete(k);
    this.map.set(k, { value, expiresAt: Date.now() + Math.max(1, ttlSec) * 1000 });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  del(key: string): void {
    this.map.delete(NS + key);
  }

  delPrefix(prefix: string): void {
    const p = NS + prefix;
    for (const k of [...this.map.keys()]) if (k.startsWith(p)) this.map.delete(k);
  }

  incr(hash: string, field: string, n: number): number {
    const key = `${hash}:${field}`;
    const cur = (this.get<number>(key) ?? 0) + n;
    this.set(key, cur, 24 * 3600);
    return cur;
  }

  async wrap<T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.get<T>(key);
    if (hit !== undefined) return hit;
    const running = this.inflight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const p = fn()
      .then((v) => {
        this.set(key, v, ttlSec);
        return v;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  size(): number {
    return this.map.size;
  }
}

/** True when the kv is Redis, i.e. there may be other instances to agree with. */
function shared(): boolean {
  return kv.backend === 'redis';
}

/** Ranked lists, benchmarks, insights. In-process on every deploy; see genKey(). */
export const recoCache: CacheBackend = new MemoryCache(5000);

// ---------------------------------------------------------------------------
// Rid store
// ---------------------------------------------------------------------------

/**
 * A bounded in-process LRU, written through to the shared kv when there is
 * one. Reads hit memory first; a miss asks the kv and warms memory with the
 * answer, so a rid crosses the network at most once per instance.
 */
export class RidStore {
  private readonly local: MemoryCache;

  constructor(private readonly kvPrefix: string, max: number) {
    this.local = new MemoryCache(max);
  }

  /** This instance's copy only. Synchronous; used to merge before a write. */
  peek<T>(key: string): T | undefined {
    return this.local.get<T>(key);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const hit = this.local.get<T>(key);
    if (hit !== undefined || !shared()) return hit;
    const remote = await kv.getJson<{ v: T; exp: number }>(this.kvPrefix + key);
    if (!remote) return undefined;
    const ttlSec = Math.floor((remote.exp - Date.now()) / 1000);
    if (ttlSec > 0) this.local.set(key, remote.v, ttlSec);
    return remote.v;
  }

  /**
   * Stores locally at once (same-process lookups never wait) and hands the kv
   * write off in the background. `merge` runs against the shared copy before
   * that write, so two instances serving one public rid keep both their items
   * (best effort: two writes in the same instant can still drop one side's).
   */
  set<T>(key: string, value: T, ttlSec: number, merge?: (prev: T) => T): void {
    this.local.set(key, value, ttlSec);
    if (!shared()) return;
    void (async () => {
      let v = value;
      if (merge) {
        const prev = await kv.getJson<{ v: T }>(this.kvPrefix + key);
        if (prev) v = merge(prev.v);
      }
      // The absolute expiry travels with the value so a reader re-caches it
      // for what is left, not for a fresh full TTL.
      await kv.setJson(this.kvPrefix + key, { v, exp: Date.now() + ttlSec * 1000 }, ttlSec * 1000);
    })().catch((err) => logger.warn({ err }, 'reco rid store: shared write failed'));
  }
}

/**
 * Request-id registry: which listings a response actually served, and the
 * ranked list behind "Show more". Separate from the result cache so a burst of
 * rids can never evict ranked lists (and vice versa).
 */
export const ridStore = new RidStore(`${NS}rid:`, 20000);

/**
 * Long-lived rids (the email digest, clicked days later), kept apart so a
 * burst of page views cannot evict them before the week is out. Shared too:
 * the instance that sent the digest is rarely the one the click lands on.
 */
export const longRidStore = new RidStore(`${NS}ridl:`, 50000);

// ---------------------------------------------------------------------------
// Cluster-wide invalidation
// ---------------------------------------------------------------------------

/**
 * Generations outlive any cached result (TTLs are capped at an hour), so a
 * counter that expires and restarts cannot collide with a live entry.
 */
const GEN_TTL_MS = 7 * 24 * 3600 * 1000;
/** How long this instance trusts its copy of the global generation. */
const GLOBAL_GEN_REFRESH_MS = 5_000;

const genKvKey = (scope: string) => `${NS}gen:${scope}`;

let globalGen = { value: '0', checkedAt: 0 };

async function readGlobalGen(): Promise<string> {
  if (Date.now() - globalGen.checkedAt < GLOBAL_GEN_REFRESH_MS) return globalGen.value;
  const value = (await kv.get(genKvKey('all'))) ?? '0';
  if (value !== globalGen.value && globalGen.checkedAt > 0) {
    // Another instance saved the config or rebuilt: drop what we hold and
    // re-read the config now rather than on its own 60s timer.
    recoCache.delPrefix('');
    invalidateRecoConfig();
  }
  globalGen = { value, checkedAt: Date.now() };
  return value;
}

/**
 * The cache key to use for `key`, carrying the generation of every scope it
 * depends on ('all' is always included). One kv read per extra scope, plus the
 * global one at most every few seconds. The key is unchanged on a single
 * server, where the local prefix delete already is the whole story.
 */
export async function genKey(key: string, scopes: string[] = []): Promise<string> {
  if (!shared()) return key;
  const gens = await Promise.all([readGlobalGen(), ...scopes.map(async (s) => (await kv.get(genKvKey(s))) ?? '0')]);
  return `${key}:g${gens.join('.')}`;
}

function bump(scope: string): void {
  if (!shared()) return;
  void kv.incr(genKvKey(scope), GEN_TTL_MS).then(() => {
    // Our own next lookup should not wait out the refresh window.
    if (scope === 'all') globalGen = { ...globalGen, checkedAt: 0 };
  });
}

/** Drops every cached result for one parent (save, enquiry, pet change, city change). */
export function invalidateParent(parentId: string): void {
  recoCache.delPrefix(`parent:${parentId}:`);
  bump(`parent:${parentId}`);
}

/** Drops one vendor's cached insights, on every instance. */
export function invalidateVendor(vendorId: string): void {
  recoCache.del(`vendor:${vendorId}`);
  recoCache.delPrefix(`vendor:${vendorId}:`);
  bump(`vendor:${vendorId}`);
}

/** Drops every cached ranked list (config change, featured change, rebuild). */
export function invalidateAllResults(): void {
  recoCache.delPrefix('');
  bump('all');
}

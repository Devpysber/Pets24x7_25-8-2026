// A small async key/value cache that is shared between API instances when
// REDIS_URL is set, and lives in this process otherwise.
//
//   import { kv } from '../shared/kv.js';
//   await kv.set('reco:home:IN', payload, 60_000);
//   const hit = await kv.getJson<Payload>('reco:home:IN');
//   const fresh = await kv.remember('reco:home:IN', 60_000, () => build());
//
// Two rules the callers can rely on:
//
//   • It never throws because Redis is down. A failed Redis call is logged
//     (throttled) and answered from the in-process store instead, so a cache
//     outage degrades to "each server has its own cache", not to 500s. The
//     same holds while the first connection is still being made.
//   • It is a cache, not a database. Values can vanish at any time (TTL, LRU
//     eviction, a Redis restart, the fallback switching in). Anything that must
//     survive belongs in MySQL.
//
// Values are strings; the *Json helpers wrap JSON.stringify/parse. Every key is
// namespaced with REDIS_KEY_PREFIX on the Redis side.

import type { Redis as RedisClient } from 'ioredis';

import { env } from '../env.js';
import { logger } from '../logger.js';

export interface IncrResult {
  /** Counter value after this increment. */
  value: number;
  /** Milliseconds until the counter resets. */
  ttlMs: number;
}

export interface Kv {
  readonly backend: 'redis' | 'memory';
  get(key: string): Promise<string | null>;
  /** ttlMs omitted or <= 0 means no expiry (memory entries can still be evicted). */
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  /**
   * Adds `by` (default 1) to a counter. The window starts on the first
   * increment and is not extended by later ones — a fixed window, which is
   * what rate limiting wants.
   */
  incr(key: string, ttlMs: number, by?: number): Promise<IncrResult>;
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown, ttlMs?: number): Promise<void>;
  /** Cached value if present, otherwise loads, stores and returns it. */
  remember<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// In-memory LRU with per-entry TTL
// ---------------------------------------------------------------------------

interface Entry {
  value: string;
  /** Epoch ms; 0 = no expiry. */
  expiresAt: number;
}

export class MemoryKv {
  // A Map iterates in insertion order, so re-inserting on read makes the first
  // key the least recently used one.
  private readonly map = new Map<string, Entry>();

  constructor(private readonly maxEntries: number) {
    // Expired entries are dropped on read; this sweep keeps ones nobody reads
    // again from sitting in memory until LRU pressure reaches them.
    setInterval(() => this.sweep(), 60_000).unref?.();
  }

  get size(): number {
    return this.map.size;
  }

  private live(key: string, now = Date.now()): Entry | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt && e.expiresAt <= now) {
      this.map.delete(key);
      return undefined;
    }
    return e;
  }

  private put(key: string, entry: Entry): void {
    this.map.delete(key);
    this.map.set(key, entry);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get(key: string): string | null {
    const e = this.live(key);
    if (!e) return null;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: string, ttlMs?: number): void {
    this.put(key, { value, expiresAt: ttlMs && ttlMs > 0 ? Date.now() + ttlMs : 0 });
  }

  del(key: string): void {
    this.map.delete(key);
  }

  incr(key: string, ttlMs: number, by = 1): IncrResult {
    const now = Date.now();
    const e = this.live(key, now);
    const current = e ? Number(e.value) || 0 : 0;
    const expiresAt = e?.expiresAt || now + Math.max(1, ttlMs);
    const value = current + by;
    this.put(key, { value: String(value), expiresAt });
    return { value, ttlMs: Math.max(0, expiresAt - now) };
  }

  sweep(now = Date.now()): void {
    for (const [k, e] of this.map) {
      if (e.expiresAt && e.expiresAt <= now) this.map.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// Redis (optional)
// ---------------------------------------------------------------------------

// INCRBY, then set the window only on a fresh key (or one that somehow lost
// its TTL), and report what is left of it — in one round trip, atomically.
const INCR_WINDOW_LUA = `
local v = redis.call('INCRBY', KEYS[1], ARGV[2])
local t = redis.call('PTTL', KEYS[1])
if t < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  t = tonumber(ARGV[1])
end
return {v, t}
`;

let client: RedisClient | null = null;
let connecting: Promise<RedisClient | null> | null = null;
let lastErrorLogAt = 0;

/** One warning a minute at most: a Redis outage must not flood the log. */
function logRedisError(err: unknown, op: string): void {
  const now = Date.now();
  if (now - lastErrorLogAt < 60_000) return;
  lastErrorLogAt = now;
  logger.warn({ err, op }, 'redis unavailable; serving from in-process memory until it recovers');
}

/**
 * The shared client, connected on first use. Returns null (so the caller uses
 * memory) while REDIS_URL is unset, the module failed to load, or the
 * connection is not ready. ioredis reconnects on its own in the background.
 */
async function redis(): Promise<RedisClient | null> {
  if (!env.REDIS_URL) return null;
  if (client) return client.status === 'ready' ? client : null;
  if (!connecting) {
    connecting = (async () => {
      try {
        const { Redis } = await import('ioredis');
        const c = new Redis(env.REDIS_URL!, {
          keyPrefix: env.REDIS_KEY_PREFIX,
          lazyConnect: true,
          // Fail fast instead of queueing: a request waiting on a dead cache is
          // worse than a request that falls back to memory.
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          connectTimeout: 5_000,
          retryStrategy: (times) => Math.min(times * 500, 10_000),
        });
        c.on('error', (err) => logRedisError(err, 'connection'));
        c.on('ready', () => logger.info('redis connected (shared cache + rate limits)'));
        c.defineCommand('p24IncrWindow', { numberOfKeys: 1, lua: INCR_WINDOW_LUA });
        client = c;
        // Not awaited: requests made while the socket is still opening are
        // served from memory rather than held up by the connect timeout.
        void c.connect().catch((err) => logRedisError(err, 'connect'));
        return c;
      } catch (err) {
        logRedisError(err, 'init');
        return null;
      }
    })();
  }
  const c = await connecting;
  return c && c.status === 'ready' ? c : null;
}

/** Opens the Redis connection at boot, so the first requests already share state. No-op without REDIS_URL. */
export function warmKv(): void {
  void redis();
}

/** Closes the Redis connection, if any. For a clean shutdown and for tests. */
export async function closeKv(): Promise<void> {
  const c = client;
  client = null;
  connecting = null;
  if (c) await c.quit().catch(() => c.disconnect());
}

// ---------------------------------------------------------------------------
// The facade
// ---------------------------------------------------------------------------

const memory = new MemoryKv(env.KV_MEMORY_MAX_ENTRIES);

/** Runs `op` on Redis when it is usable, otherwise (or on failure) on memory. */
async function withRedis<T>(name: string, op: (r: RedisClient) => Promise<T>, fallback: () => T): Promise<T> {
  const r = await redis();
  if (!r) return fallback();
  try {
    return await op(r);
  } catch (err) {
    logRedisError(err, name);
    return fallback();
  }
}

type IncrWindowClient = RedisClient & {
  p24IncrWindow(key: string, ttl: number, by: number): Promise<[number, number]>;
};

/**
 * Fixed-window increment on Redis only. Resolves null when Redis is not
 * configured, not connected, or the call failed, so the caller can pick its
 * own fallback (the rate limiter keeps a dedicated memory store for that).
 */
export async function redisIncr(key: string, ttlMs: number, by = 1): Promise<IncrResult | null> {
  const r = await redis();
  if (!r) return null;
  try {
    const out = await (r as IncrWindowClient).p24IncrWindow(key, Math.max(1, Math.ceil(ttlMs)), by);
    return { value: Number(out[0]), ttlMs: Math.max(0, Number(out[1])) };
  } catch (err) {
    logRedisError(err, 'incr');
    return null;
  }
}

export const kv: Kv = {
  get backend() {
    return env.REDIS_URL ? 'redis' : 'memory';
  },

  get(key) {
    return withRedis('get', (r) => r.get(key), () => memory.get(key));
  },

  async set(key, value, ttlMs) {
    await withRedis(
      'set',
      async (r) => {
        if (ttlMs && ttlMs > 0) await r.set(key, value, 'PX', Math.ceil(ttlMs));
        else await r.set(key, value);
      },
      () => memory.set(key, value, ttlMs),
    );
  },

  async del(key) {
    await withRedis('del', async (r) => { await r.del(key); }, () => memory.del(key));
  },

  async incr(key, ttlMs, by = 1) {
    return (await redisIncr(key, ttlMs, by)) ?? memory.incr(key, ttlMs, by);
  },

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await kv.get(key);
    if (raw == null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },

  async setJson(key, value, ttlMs) {
    await kv.set(key, JSON.stringify(value), ttlMs);
  },

  async remember<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = await kv.getJson<{ v: T }>(key);
    if (hit) return hit.v;
    const v = await load();
    // Boxed so a legitimately cached null/false is a hit, not a miss.
    await kv.setJson(key, { v }, ttlMs);
    return v;
  },
};

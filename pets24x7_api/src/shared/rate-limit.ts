// One way to build a rate limiter, so every limit in the API is shared across
// instances once there is more than one.
//
// express-rate-limit keeps its counters in process memory by default. Behind a
// load balancer with N API servers that multiplies every budget by N — four
// OTP sends a minute becomes 4N, ten admin password guesses per five minutes
// becomes 10N — because each server only sees its own share of the traffic.
//
//   makeLimiter('admin-login', { windowMs: 5 * 60_000, max: 10, standardHeaders: true })
//
// Without REDIS_URL this returns exactly the limiter it always did (the stock
// MemoryStore), so a single server behaves as before. With REDIS_URL the
// counters live in Redis under `rl:<name>:<client key>`, and while Redis is
// unreachable each limiter falls back to its own in-memory store: limits keep
// working per server rather than failing open or turning into 500s.
//
// `name` must be unique per limiter. Two limiters with the same name would
// share one counter in Redis and each would count the other's hits.

import rateLimit, { MemoryStore, type Options, type RateLimitRequestHandler, type Store, type IncrementResponse } from 'express-rate-limit';

import { env } from '../env.js';
import { kv, redisIncr } from './kv.js';

const names = new Set<string>();

/** express-rate-limit Store backed by kv (Redis), with a per-limiter memory fallback. */
class KvStore implements Store {
  readonly localKeys = false;
  readonly prefix: string;
  private windowMs = 60_000;
  private readonly fallback = new MemoryStore();

  constructor(name: string) {
    this.prefix = `rl:${name}:`;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
    this.fallback.init(options);
  }

  // Not kv.incr: its memory fallback is an LRU shared with the cache, where a
  // flood of distinct client keys could evict counters. While Redis is down
  // each limiter uses its own stock MemoryStore instead.
  async increment(key: string): Promise<IncrementResponse> {
    const hit = await redisIncr(this.prefix + key, this.windowMs);
    if (!hit) return this.fallback.increment(key);
    return { totalHits: hit.value, resetTime: new Date(Date.now() + hit.ttlMs) };
  }

  async decrement(key: string): Promise<void> {
    const hit = await redisIncr(this.prefix + key, this.windowMs, -1);
    if (!hit) this.fallback.decrement(key);
  }

  async resetKey(key: string): Promise<void> {
    await kv.del(this.prefix + key);
    this.fallback.resetKey(key);
  }

  shutdown(): void {
    this.fallback.shutdown();
  }
}

export type LimiterOptions = Partial<Omit<Options, 'store'>>;

/**
 * A rate limiter that shares its counters across API instances when REDIS_URL
 * is set. Accepts the same options as express-rate-limit.
 */
export function makeLimiter(name: string, opts: LimiterOptions): RateLimitRequestHandler {
  if (names.has(name)) throw new Error(`makeLimiter: duplicate limiter name "${name}"`);
  names.add(name);
  if (!env.REDIS_URL) return rateLimit(opts);
  return rateLimit({ ...opts, store: new KvStore(name) });
}

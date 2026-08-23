// Concrete RateLimiterPort adapter: fixed window on Redis (INCR + EXPIRE).
//
// Fixed window, not sliding: it is one round trip, it needs no stored history,
// and its worst case (2x the limit across a window boundary) is irrelevant for
// the numbers used here. Nothing connects at import time (lib/redis.ts is
// lazy), so this is safe to construct under `bun test`.
import { getRedis } from "../../lib/redis";
import type { RateLimiterPort, RateLimitResult } from "../ports/ratelimit";

export interface RateLimiterOptions {
  /**
   * What to do when Redis itself fails. See core/ports/ratelimit.ts: `true`
   * for the global limiter, `false` for auth.
   */
  failOpen: boolean;
}

export function createRateLimiterAdapter({ failOpen }: RateLimiterOptions): RateLimiterPort {
  return {
    async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
      try {
        const redis = getRedis();
        const count = await redis.incr(key);
        if (count === 1) {
          await redis.expire(key, windowSeconds);
        }
        // Only ask for the TTL when we actually need it for Retry-After.
        let retryAfterSeconds = windowSeconds;
        if (count > limit) {
          const ttl = await redis.ttl(key);
          retryAfterSeconds = ttl > 0 ? ttl : windowSeconds;
        }
        return {
          allowed: count <= limit,
          remaining: Math.max(0, limit - count),
          retryAfterSeconds,
        };
      } catch {
        return failOpen
          ? { allowed: true, remaining: limit, retryAfterSeconds: 0 }
          : { allowed: false, remaining: 0, retryAfterSeconds: windowSeconds };
      }
    },

    async reset(key: string): Promise<void> {
      try {
        await getRedis().del(key);
      } catch {
        // Resetting a counter is best effort in both policies: the worst case
        // is a legitimate user waiting out a window they already cleared.
      }
    },
  };
}

/** In-memory limiter with the same contract, for tests that must not need Redis. */
export function createMemoryRateLimiter(now: () => number = Date.now): RateLimiterPort {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    async consume(key, limit, windowSeconds) {
      const current = windows.get(key);
      const t = now();
      const window = current && current.resetAt > t ? current : { count: 0, resetAt: t + windowSeconds * 1000 };
      window.count += 1;
      windows.set(key, window);
      return {
        allowed: window.count <= limit,
        remaining: Math.max(0, limit - window.count),
        retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - t) / 1000)),
      };
    },
    async reset(key) {
      windows.delete(key);
    },
  };
}

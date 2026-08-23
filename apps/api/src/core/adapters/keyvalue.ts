// Concrete KeyValueStorePort adapter on ioredis. Importing this module never
// opens a socket (see lib/redis.ts, lazyConnect).
//
// Unlike core/adapters/redis.ts this adapter does NOT swallow errors: sessions
// and config invalidation must fail loudly. See core/ports/keyvalue.ts.
import { getRedis } from "../../lib/redis";
import type { KeyValueStorePort } from "../ports/keyvalue";

export function createKeyValueAdapter(): KeyValueStorePort {
  return {
    async get(key: string): Promise<string | null> {
      return getRedis().get(key);
    },
    async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
      if (ttlSeconds === undefined) {
        await getRedis().set(key, value);
        return;
      }
      // Guard against EX 0 / negative, which Redis rejects with an error.
      // A caller asking for a non-positive TTL means "already expired", so
      // write it with the shortest legal life instead of throwing.
      await getRedis().set(key, value, "EX", Math.max(1, Math.floor(ttlSeconds)));
    },
    async del(key: string): Promise<number> {
      return getRedis().del(key);
    },
    async ttl(key: string): Promise<number> {
      return getRedis().ttl(key);
    },
  };
}

/**
 * In-memory KeyValueStorePort with the same strict contract. Used by tests
 * that must not depend on a live Redis, and by nothing in production.
 * Honours TTL against a monotonic clock so expiry is observable without
 * sleeping.
 */
export function createMemoryKeyValueStore(now: () => number = Date.now): KeyValueStorePort {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  const live = (key: string): { value: string; expiresAt: number | null } | undefined => {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= now()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, ttlSeconds) {
      store.set(key, {
        value,
        expiresAt: ttlSeconds === undefined ? null : now() + Math.max(1, Math.floor(ttlSeconds)) * 1000,
      });
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    },
    async ttl(key) {
      const entry = live(key);
      if (!entry) return -2;
      if (entry.expiresAt === null) return -1;
      return Math.ceil((entry.expiresAt - now()) / 1000);
    },
  };
}

// Port interface for the strict key/value store (Redis).
//
// WHY THIS EXISTS NEXT TO CachePort
// CachePort (./redis.ts) fails OPEN on purpose: a rate limiter that blocks
// every request because Redis blinked is worse than a rate limiter that lets
// a burst through. That stance is wrong for two other uses of Redis:
//
//   - server-side sessions. A `set` that silently no-ops hands the user a
//     cookie pointing at nothing; a `del` that silently no-ops means logout
//     did not log anyone out. Both must be errors the caller sees.
//   - cache invalidation for konfigurasi. A swallowed `del` leaves a stale
//     rate in front of a financial calculation, which is exactly the failure
//     mode spec rule 3 ("parameter berubah tanpa deploy") is meant to avoid.
//
// So every method here THROWS on infrastructure failure. Callers that can
// legitimately degrade (a cache READ, which can always fall back to Postgres)
// handle that explicitly at the call site, in the open.
export interface KeyValueStorePort {
  /** Reads the value at `key`, or `null` if unset. Throws if the store is unreachable. */
  get(key: string): Promise<string | null>;
  /** Writes `value` at `key` with an optional TTL in seconds. Throws on failure. */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  /** Deletes `key`. Returns the number of keys removed (0 if absent). Throws on failure. */
  del(key: string): Promise<number>;
  /** Remaining TTL in seconds; -1 when the key has no expiry, -2 when absent. */
  ttl(key: string): Promise<number>;
}

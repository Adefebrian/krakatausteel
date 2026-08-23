// Server-side session store.
//
// WHY SERVER SIDE AND OPAQUE
// The cookie carries a random 256-bit id and nothing else. No user id, no role
// list, no signature to verify, nothing to tamper with: every authorisation
// fact is re-read from Postgres on every request (see repo.loadPrincipal), so
// deactivating a user or removing a role takes effect on their next request
// instead of whenever their JWT happens to expire. That is also why there is
// no SESSION_SECRET in play here; there is nothing to sign.
//
// TWO DEADLINES
//   idle      slides forward on every authenticated request. This is the TTL
//             Redis itself holds, so an abandoned session evaporates without
//             anyone running a sweeper.
//   absolute  fixed at login. A session cannot be kept alive forever by a
//             script polling /auth/session; after this it must re-authenticate.
// Both are also written INTO the record and checked in code, not only handed
// to Redis, so expiry is deterministic in a test (inject a clock, no sleeping)
// and a mis-set TTL cannot silently extend a session.
import type { KeyValueStorePort } from "./ports";

const KEY_PREFIX = "tjsl:sess:";

export const DEFAULT_IDLE_TTL_SECONDS = 8 * 60 * 60;
export const DEFAULT_ABSOLUTE_TTL_SECONDS = 24 * 60 * 60;

export interface SessionRecord {
  id: string;
  userId: string;
  /** ISO timestamps. Stored as text so the record is plain JSON. */
  createdAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  /** Client facts captured at login, for the audit trail. */
  ip: string | null;
  userAgent: string | null;
}

export interface SessionStoreOptions {
  kv: KeyValueStorePort;
  idleTtlSeconds?: number;
  absoluteTtlSeconds?: number;
  now?: () => Date;
  /** Test seam: deterministic ids. */
  generateId?: () => string;
}

export interface SessionStore {
  create(input: { userId: string; ip: string | null; userAgent: string | null }): Promise<SessionRecord>;
  /** Reads and slides the idle deadline. Returns null when absent or expired. */
  touch(sessionId: string): Promise<SessionRecord | null>;
  destroy(sessionId: string): Promise<boolean>;
  readonly idleTtlSeconds: number;
}

/** 256 bits of CSPRNG output, URL-safe. Never a counter, never a UUIDv4. */
export function generateSessionId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export function createSessionStore({
  kv,
  idleTtlSeconds = DEFAULT_IDLE_TTL_SECONDS,
  absoluteTtlSeconds = DEFAULT_ABSOLUTE_TTL_SECONDS,
  now = () => new Date(),
  generateId = generateSessionId,
}: SessionStoreOptions): SessionStore {
  const key = (id: string): string => `${KEY_PREFIX}${id}`;

  return {
    idleTtlSeconds,

    async create({ userId, ip, userAgent }) {
      const issued = now();
      const record: SessionRecord = {
        id: generateId(),
        userId,
        createdAt: issued.toISOString(),
        idleExpiresAt: new Date(issued.getTime() + idleTtlSeconds * 1000).toISOString(),
        absoluteExpiresAt: new Date(issued.getTime() + absoluteTtlSeconds * 1000).toISOString(),
        ip,
        userAgent,
      };
      // Throws if Redis is unreachable (KeyValueStorePort is strict): a login
      // that could not persist its session must fail, not hand out a cookie
      // pointing at nothing.
      await kv.set(key(record.id), JSON.stringify(record), idleTtlSeconds);
      return record;
    },

    async touch(sessionId) {
      if (sessionId.length === 0 || sessionId.length > 128) return null;
      const raw = await kv.get(key(sessionId));
      if (raw === null) return null;

      let record: SessionRecord;
      try {
        record = JSON.parse(raw) as SessionRecord;
      } catch {
        // Corrupt record: treat as no session and remove it rather than
        // letting a parse error become a 500 on every request.
        await kv.del(key(sessionId));
        return null;
      }

      const t = now().getTime();
      if (Date.parse(record.absoluteExpiresAt) <= t || Date.parse(record.idleExpiresAt) <= t) {
        await kv.del(key(sessionId));
        return null;
      }

      const slid = Math.min(t + idleTtlSeconds * 1000, Date.parse(record.absoluteExpiresAt));
      const updated: SessionRecord = { ...record, idleExpiresAt: new Date(slid).toISOString() };
      await kv.set(key(sessionId), JSON.stringify(updated), Math.ceil((slid - t) / 1000));
      return updated;
    },

    async destroy(sessionId) {
      return (await kv.del(key(sessionId))) > 0;
    },
  };
}

// The MITRA session store. A deliberate near-copy of modules/auth/session.ts,
// and the duplication is the security property rather than an oversight.
//
// WHY NOT REUSE `createSessionStore`
// That store's keyspace is `tjsl:sess:` and its record carries a `userId`
// meaning `app_user.id`. Reusing it for a mitra would mean one namespace
// holding two kinds of subject distinguished only by a field, so any resolver
// that read a record without checking which kind it was would turn one into
// the other. Two stores, two prefixes, two record shapes: a mitra session id
// looked up by the staff store is a MISS, not a mis-typed hit, and the same
// the other way round. That is a guarantee about the shape of the data, not a
// guarantee about somebody remembering to write an `if`.
//
// The rest of the reasoning (opaque 256-bit id, no authorisation facts in the
// record, two deadlines checked in code as well as handed to Redis) is
// modules/auth/session.ts's and holds here unchanged. The lifetimes are
// shorter; see IDLE_TTL_MITRA_DETIK in ./contract.ts.
import type { KeyValueStorePort } from "../../core/ports/keyvalue";
import {
  ABSOLUTE_TTL_MITRA_DETIK,
  IDLE_TTL_MITRA_DETIK,
  type MitraSessionRecord,
  type MitraSessionStore,
} from "./contract";

/** DIFFERENT FROM `tjsl:sess:`, and that difference is load-bearing. */
const PREFIX_KUNCI = "tjsl:msess:";

export interface MitraSessionStoreOptions {
  kv: KeyValueStorePort;
  idleTtlSeconds?: number;
  absoluteTtlSeconds?: number;
  now?: () => Date;
  /** Test seam: deterministic ids. */
  generateId?: () => string;
}

/** 256 bits of CSPRNG output, URL-safe. Never a counter, never a UUIDv4. */
export function generateMitraSessionId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export function createMitraSessionStore({
  kv,
  idleTtlSeconds = IDLE_TTL_MITRA_DETIK,
  absoluteTtlSeconds = ABSOLUTE_TTL_MITRA_DETIK,
  now = () => new Date(),
  generateId = generateMitraSessionId,
}: MitraSessionStoreOptions): MitraSessionStore {
  const kunci = (id: string): string => `${PREFIX_KUNCI}${id}`;

  return {
    idleTtlSeconds,

    async create({ akunId, ip, userAgent }) {
      const terbit = now();
      const record: MitraSessionRecord = {
        id: generateId(),
        akunId,
        createdAt: terbit.toISOString(),
        idleExpiresAt: new Date(terbit.getTime() + idleTtlSeconds * 1000).toISOString(),
        absoluteExpiresAt: new Date(terbit.getTime() + absoluteTtlSeconds * 1000).toISOString(),
        ip,
        userAgent,
      };
      // Throws if Redis is unreachable (KeyValueStorePort is strict): a login
      // that could not persist its session must fail, not hand out a cookie
      // pointing at nothing.
      await kv.set(kunci(record.id), JSON.stringify(record), idleTtlSeconds);
      return record;
    },

    async touch(sessionId) {
      if (sessionId.length === 0 || sessionId.length > 128) return null;
      const mentah = await kv.get(kunci(sessionId));
      if (mentah === null) return null;

      let record: MitraSessionRecord;
      try {
        record = JSON.parse(mentah) as MitraSessionRecord;
      } catch {
        await kv.del(kunci(sessionId));
        return null;
      }
      // A record without an `akunId` is not a mitra session, whatever else it
      // is. Fail closed rather than resolve half a record.
      if (typeof record.akunId !== "string" || record.akunId.length === 0) {
        await kv.del(kunci(sessionId));
        return null;
      }

      const t = now().getTime();
      if (Date.parse(record.absoluteExpiresAt) <= t || Date.parse(record.idleExpiresAt) <= t) {
        await kv.del(kunci(sessionId));
        return null;
      }

      const geser = Math.min(t + idleTtlSeconds * 1000, Date.parse(record.absoluteExpiresAt));
      const diperbarui: MitraSessionRecord = {
        ...record,
        idleExpiresAt: new Date(geser).toISOString(),
      };
      await kv.set(kunci(sessionId), JSON.stringify(diperbarui), Math.ceil((geser - t) / 1000));
      return diperbarui;
    },

    async destroy(sessionId) {
      return (await kv.del(kunci(sessionId))) > 0;
    },
  };
}

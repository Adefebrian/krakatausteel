// Authentication and principal resolution. Framework-agnostic: nothing here
// touches Hono, so every rule below is testable by calling a function.
//
// THE THREE THINGS THIS FILE IS CAREFUL ABOUT
//
// 1. NO USERNAME ENUMERATION. "unknown username", "wrong password" and
//    "deactivated account" all return the same error object, and the unknown
//    username path still performs a real argon2id verification against a
//    throwaway hash so the response time does not sort accounts into
//    "exists" and "does not exist". The distinction is recorded in audit_log,
//    where it belongs, and never in the HTTP response.
//
// 2. HARDER RATE LIMITING THAN THE GLOBAL LIMITER, on two keys at once: per
//    client IP (stops one host spraying many accounts) and per username
//    (stops a botnet spraying one account). The auth limiter is constructed
//    fail-CLOSED (core/ports/ratelimit.ts): Redis is where sessions live, so
//    if Redis is down no login could succeed anyway, and refusing beats
//    handing an attacker an unlimited-attempt window by knocking Redis over.
//
// 3. AUTHORISATION FACTS ARE NEVER CACHED IN THE SESSION. The session record
//    holds a user id; roles and permissions are re-read from Postgres on
//    every request. See session.ts for why.
import { AppError, badRequest, unauthenticated } from "../../core/http";
import type { AuditActor, AuditService } from "../audit";
import {
  PERMISSIONS_BY_ROLE,
  ROLES_LINTAS_CABANG,
  ROLES_READ_ONLY,
  type RoleCode,
} from "./permissions";
import type { DbPort, Principal, PrincipalCabang, QueryRunner, RateLimiterPort } from "./ports";
import { createAuthRepo, type AuthRepo, type PeriodeRow } from "./repo";
import { createSessionStore, type SessionRecord, type SessionStore, type SessionStoreOptions } from "./session";

/** Login attempts allowed per client IP inside the window. */
export const LOGIN_LIMIT_PER_IP = 10;
/** Login attempts allowed per username inside the window, across all IPs. */
export const LOGIN_LIMIT_PER_USERNAME = 5;
export const LOGIN_WINDOW_SECONDS = 300;

const MAX_USERNAME_LENGTH = 64;
const MAX_PASSWORD_LENGTH = 200;
/** Same wording for every failure mode. See note 1 in the file header. */
const KREDENSIAL_SALAH = "Nama pengguna atau kata sandi salah";

/**
 * Display order when a user holds several roles. Purely cosmetic: the SPA's
 * `Session.user.role` is one string, while `roles` carries the full set and is
 * what any decision is made from.
 */
const ROLE_PRECEDENCE: readonly RoleCode[] = [
  "ADMIN_PUSAT",
  "ADMIN_CABANG",
  "AUDITOR",
  "APPROVER",
  "CHECKER",
  "MAKER",
];

export interface SessionPayload {
  user: { id: string; username: string; nama: string; role: string };
  cabang: PrincipalCabang;
  cabangTersedia: readonly PrincipalCabang[];
  periode: PeriodeRow;
  permissions: readonly string[];
  /** Full role set. `user.role` is the primary one, for display only. */
  roles: readonly string[];
  readOnly: boolean;
  lintasCabang: boolean;
}

export interface LoginInput {
  username: string;
  password: string;
  ip: string | null;
  userAgent: string | null;
}

export interface LoginResult {
  session: SessionRecord;
  payload: SessionPayload;
  principal: Principal;
}

export interface AuthServiceDeps {
  db: DbPort;
  audit: AuditService;
  /** Fail-closed limiter, see note 2. */
  loginLimiter: RateLimiterPort;
  sessions?: SessionStore;
  sessionOptions?: SessionStoreOptions;
  repo?: AuthRepo;
  /** Namespace for the login rate-limit keys. */
  keyPrefix?: string;
  /** argon2id parameters. Lowered by the test harness only. */
  passwordOptions?: { memoryCost?: number; timeCost?: number };
  loginLimits?: { perIp?: number; perUsername?: number; windowSeconds?: number };
}

export interface AuthService {
  login(input: LoginInput): Promise<LoginResult>;
  logout(sessionId: string, actor: AuditActor): Promise<void>;
  /** Resolves a cookie value into a Principal, or null. Slides the session. */
  resolveSession(sessionId: string): Promise<{ principal: Principal; record: SessionRecord } | null>;
  payloadFor(principal: Principal): Promise<SessionPayload>;
  hashPassword(plain: string): Promise<string>;
  readonly sessions: SessionStore;
}

/**
 * A real argon2id hash of a value nobody knows, verified against whenever the
 * username does not exist so that path costs the same as a wrong password.
 * Built once, lazily, and never awaited at import time.
 */
let dummyHash: Promise<string> | undefined;
function getDummyHash(options: { memoryCost?: number; timeCost?: number }): Promise<string> {
  if (!dummyHash) {
    dummyHash = Bun.password.hash(crypto.randomUUID(), { algorithm: "argon2id", ...options });
  }
  return dummyHash;
}

function primaryRole(roles: readonly string[]): string {
  for (const candidate of ROLE_PRECEDENCE) {
    if (roles.includes(candidate)) return candidate;
  }
  return roles[0] ?? "TANPA_ROLE";
}

/** Calendar month fallback for a database with no periode rows yet (Fase 1). */
function periodeFallback(now: Date): PeriodeRow {
  return { tahun: now.getUTCFullYear(), bulan: now.getUTCMonth() + 1, status: "OPEN" };
}

function assertLoginShape(input: { username: unknown; password: unknown }): {
  username: string;
  password: string;
} {
  const detail: Record<string, string[]> = {};
  const username = typeof input.username === "string" ? input.username.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (username.length === 0) detail.username = ["wajib diisi"];
  else if (username.length > MAX_USERNAME_LENGTH) detail.username = ["maksimal 64 karakter"];
  if (password.length === 0) detail.password = ["wajib diisi"];
  else if (password.length > MAX_PASSWORD_LENGTH) detail.password = ["maksimal 200 karakter"];
  if (Object.keys(detail).length > 0) throw badRequest("Data login tidak valid", detail);
  return { username, password };
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const {
    db,
    audit,
    loginLimiter,
    repo = createAuthRepo(),
    keyPrefix = "tjsl",
    passwordOptions = {},
    loginLimits = {},
  } = deps;

  const sessions =
    deps.sessions ??
    createSessionStore(
      deps.sessionOptions ??
        (() => {
          throw new Error("createAuthService: sessions atau sessionOptions wajib diberikan");
        })(),
    );

  const perIp = loginLimits.perIp ?? LOGIN_LIMIT_PER_IP;
  const perUsername = loginLimits.perUsername ?? LOGIN_LIMIT_PER_USERNAME;
  const windowSeconds = loginLimits.windowSeconds ?? LOGIN_WINDOW_SECONDS;

  const usernameKey = (username: string): string =>
    `${keyPrefix}:auth:login:user:${username.toLowerCase()}`;
  const ipKey = (ip: string | null): string => `${keyPrefix}:auth:login:ip:${ip ?? "no-ip"}`;

  async function buildPrincipal(
    runner: QueryRunner,
    userId: string,
    sessionId: string,
  ): Promise<Principal | null> {
    const row = await repo.loadPrincipal(runner, userId);
    if (!row) return null;

    const roles = (row.roles ?? []).filter((role): role is string => role !== null);
    const lintasCabang = roles.some((role) => ROLES_LINTAS_CABANG.includes(role as RoleCode));
    // Read-only is "every role held is read-only": holding Auditor plus Maker
    // is a misconfiguration, and the safe reading of it is not "can write".
    const readOnly =
      roles.length > 0 && roles.every((role) => ROLES_READ_ONLY.includes(role as RoleCode));

    const home: PrincipalCabang = {
      id: row.cabang_id,
      kode: row.cabang_kode,
      nama: row.cabang_nama,
    };

    let cabangTersedia: PrincipalCabang[] = [home];
    if (lintasCabang) {
      const all = await repo.listCabang(runner, row.bumn_id);
      cabangTersedia = all.length > 0 ? all : [home];
    } else {
      const extraIds = (row.scope_cabang_ids ?? []).filter(
        (id): id is string => typeof id === "string" && id !== home.id,
      );
      if (extraIds.length > 0) {
        cabangTersedia = [home, ...(await repo.findCabangByIds(runner, extraIds))];
      }
    }

    return {
      sessionId,
      userId: row.user_id,
      username: row.username,
      nama: row.nama,
      cabang: home,
      bumnId: row.bumn_id,
      roles,
      // The permission list is whatever role_permission says, not a hardcoded
      // table: spec 4.1 wants RBAC as data, so an operator can add a role.
      permissions: (row.permissions ?? []).filter((code): code is string => code !== null),
      lintasCabang,
      readOnly,
      cabangTersedia,
    };
  }

  async function payloadFor(principal: Principal): Promise<SessionPayload> {
    const periode = (await repo.currentPeriode(db, principal.bumnId)) ?? periodeFallback(new Date());
    return {
      user: {
        id: principal.userId,
        username: principal.username,
        nama: principal.nama,
        role: primaryRole(principal.roles),
      },
      cabang: principal.cabang,
      cabangTersedia: principal.cabangTersedia,
      periode,
      permissions: principal.permissions,
      roles: principal.roles,
      readOnly: principal.readOnly,
      lintasCabang: principal.lintasCabang,
    };
  }

  return {
    sessions,
    payloadFor,

    async hashPassword(plain: string): Promise<string> {
      return Bun.password.hash(plain, { algorithm: "argon2id", ...passwordOptions });
    },

    async login(rawInput: LoginInput): Promise<LoginResult> {
      const { username, password } = assertLoginShape(rawInput);
      const actor: AuditActor = { ip: rawInput.ip, userAgent: rawInput.userAgent };

      const deny = async (keterangan: string, userId?: string | null): Promise<never> => {
        // Written before the response is produced, and NOT swallowed: an
        // unlogged failed login is a hole in the evidence (spec 2 rule 5).
        await audit.recordFor({ ...actor, userId: userId ?? null }, {
          aksi: "auth.login",
          entitas: "app_user",
          entitasId: userId ?? null,
          nilaiBaru: { username },
          hasil: "DITOLAK",
          keterangan,
        });
        throw unauthenticated(KREDENSIAL_SALAH);
      };

      const [byIp, byUser] = await Promise.all([
        loginLimiter.consume(ipKey(rawInput.ip), perIp, windowSeconds),
        loginLimiter.consume(usernameKey(username), perUsername, windowSeconds),
      ]);
      if (!byIp.allowed || !byUser.allowed) {
        const retryAfter = Math.max(
          1,
          byIp.allowed ? byUser.retryAfterSeconds : byIp.retryAfterSeconds,
        );
        await audit.recordFor(actor, {
          aksi: "auth.login",
          entitas: "app_user",
          nilaiBaru: { username },
          hasil: "DITOLAK",
          keterangan: `rate limit login terlampaui (${byIp.allowed ? "per username" : "per IP"})`,
        });
        throw new AppError(
          "TERLALU_BANYAK_PERMINTAAN",
          `Terlalu banyak upaya masuk. Coba lagi dalam ${retryAfter} detik.`,
          { retryAfterSeconds: [String(retryAfter)] },
        );
      }

      const credential = await repo.findCredentialByUsername(db, username);
      if (!credential) {
        // Constant-work path: verify against a throwaway hash so an unknown
        // username is not measurably faster than a wrong password.
        await Bun.password.verify(password, await getDummyHash(passwordOptions)).catch(() => false);
        return deny("username tidak ditemukan");
      }
      if (!credential.aktif) {
        await Bun.password.verify(password, credential.password_hash).catch(() => false);
        return deny("akun tidak aktif", credential.id);
      }

      const ok = await Bun.password.verify(password, credential.password_hash).catch(() => false);
      if (!ok) return deny("kata sandi salah", credential.id);

      const record = await sessions.create({
        userId: credential.id,
        ip: rawInput.ip,
        userAgent: rawInput.userAgent,
      });

      const principal = await buildPrincipal(db, credential.id, record.id);
      if (!principal) {
        // The credential row exists but the principal query rejected it
        // (deactivated between the two reads, or its cabang is soft-deleted).
        await sessions.destroy(record.id);
        return deny("principal tidak dapat dibangun (user atau cabang tidak aktif)", credential.id);
      }

      await repo.touchLastLogin(db, credential.id);
      // A successful login clears the per-username counter so a user who
      // fumbled their password four times is not locked out afterwards. The
      // per-IP counter stays: it is the spray defence.
      await loginLimiter.reset(usernameKey(username));

      await audit.recordFor({ ...actor, userId: credential.id }, {
        aksi: "auth.login",
        entitas: "app_user",
        entitasId: credential.id,
        nilaiBaru: { username: credential.username, roles: principal.roles },
        hasil: "SUKSES",
        keterangan: "login berhasil",
      });

      return { session: record, payload: await payloadFor(principal), principal };
    },

    async logout(sessionId: string, actor: AuditActor): Promise<void> {
      const removed = await sessions.destroy(sessionId);
      await audit.recordFor(actor, {
        aksi: "auth.logout",
        entitas: "app_user",
        entitasId: actor.userId ?? null,
        hasil: "SUKSES",
        keterangan: removed ? "sesi dihapus" : "sesi sudah tidak ada",
      });
    },

    async resolveSession(sessionId: string) {
      const record = await sessions.touch(sessionId);
      if (!record) return null;
      const principal = await buildPrincipal(db, record.userId, record.id);
      if (!principal) {
        // The user was deactivated or soft-deleted while holding a live
        // session: drop the session rather than let it keep resolving.
        await sessions.destroy(record.id);
        return null;
      }
      return { principal, record };
    },

  };
}

/** Exported for the RBAC seed: the canonical role to permission mapping. */
export { PERMISSIONS_BY_ROLE };

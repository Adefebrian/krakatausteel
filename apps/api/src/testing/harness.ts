// Authorisation test harness. Spec 2 rule 4: "Buat test yang memanggil
// endpoint langsung dengan role yang salah dan pastikan ditolak." This is the
// machinery for doing that, built once here so Fase 1 to Fase 9 reuse it
// instead of each phase inventing its own half-complete version.
//
// FOUR RULES IT FOLLOWS
//
// 1. THE APP UNDER TEST IS THE REAL APP. It comes from core/app.ts's
//    `createApp`, the same factory the server uses. The only overrides are
//    cost knobs: argon2 parameters, session lifetimes, rate-limit ceilings,
//    and a Redis key namespace. Wiring, guards and route registration are
//    never substituted, because an authorisation test against a differently
//    assembled app proves nothing about what ships.
//
// 2. EVERY FIXTURE IS UNIQUE. Another agent runs `bun run db:reset` on
//    tjsl_test from time to time, which truncates everything mid-run, and test
//    files share one Postgres. So each fixture creates its own bumn, branches,
//    users and employees under a random suffix, and no test depends on rows
//    left behind by another file. The only shared, re-created-on-demand state
//    is the RBAC catalogue, which is global by definition (permission.kode is
//    unique) and is re-seeded idempotently by `ensureRbac`.
//
// 3. IT TALKS HTTP. Helpers return real `Response` objects from
//    `app.request(...)`, including `Set-Cookie`, so a test exercises the guard
//    chain, the error handler and the cookie policy rather than calling a
//    service directly. Calling a service directly is fine for a unit test of
//    a rule; it is not a substitute for hitting the endpoint.
//
// 4. NO SLEEPING. Session expiry is tested by moving an injected clock, not by
//    waiting. See `createFixture({ clock })`.
import { createApp, type AppOverrides } from "../core/app";
import { SESSION_COOKIE, type RoleCode } from "../modules/auth";
import type { DbPort } from "../core/ports/db";
import { nativeFetchApi } from "./native-fetch";
import { seedRbac } from "../seed/rbac";
import { seedKonfigurasiTambahan } from "../seed/konfigurasi";

/** Password for every fixture user. Test-only, never written to a real DB. */
export const TEST_PASSWORD = "UjiCoba#12345";

/** argon2id at its floor: correctness is identical, ~2ms instead of ~50ms. */
const FAST_PASSWORD_OPTIONS = { memoryCost: 4096, timeCost: 1 } as const;

export interface TestCabang {
  id: string;
  kode: string;
  nama: string;
}

export interface TestUser {
  id: string;
  username: string;
  role: RoleCode;
  cabang: TestCabang;
}

/** A movable clock, so session expiry is deterministic. */
export interface TestClock {
  now: () => Date;
  advance: (ms: number) => void;
  set: (date: Date) => void;
}

export function createTestClock(start = new Date("2026-08-23T09:00:00.000Z")): TestClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
    set: (date: Date) => {
      current = date.getTime();
    },
  };
}

export interface RequestOptions {
  method?: string;
  /** Raw cookie value (the session id), as returned by `login`. */
  cookie?: string | null;
  headers?: Record<string, string>;
  body?: unknown;
  /** Convenience for the X-Forwarded-For chain. */
  forwardedFor?: string;
}

export interface Fixture {
  ctx: ReturnType<typeof createApp>;
  db: DbPort;
  suffix: string;
  bumnId: string;
  pusat: TestCabang;
  /** Branch A: where the Maker/Checker/Approver/Admin Cabang users live. */
  cabangA: TestCabang;
  /** Branch B: the "other branch" for spec 16 scenario 24. */
  cabangB: TestCabang;
  users: Record<RoleCode, TestUser> & { MAKER_B: TestUser };
  /** One employee row per branch, for the by-id scope test. */
  karyawanA: string;
  karyawanB: string;
  clock: TestClock;
  /** Logs in and returns the session cookie value, or throws on a non-200. */
  login(username: string, password?: string): Promise<string>;
  /** Login that is expected to fail; returns the raw Response. */
  tryLogin(username: string, password: string, options?: RequestOptions): Promise<Response>;
  request(path: string, options?: RequestOptions): Promise<Response>;
  /** Rows the audit trail holds for this fixture's users. */
  auditRows(filter?: { hasil?: "SUKSES" | "DITOLAK"; aksi?: string; userId?: string }): Promise<AuditRowLite[]>;
  /**
   * Teardown. Soft-deletes this fixture's bumn so it stops counting as a live
   * reporting entity. See the FIXTURE LEAK note below for why this exists and
   * why it is a soft delete rather than a cleanup.
   */
  tutup(): Promise<void>;
}

export interface AuditRowLite {
  id: string;
  user_id: string | null;
  ip: string | null;
  aksi: string;
  entitas: string;
  hasil: string;
  keterangan: string | null;
  nilai_lama_json: unknown;
  nilai_baru_json: unknown;
}

// ---------------------------------------------------------------------------
// FIXTURE LEAK: why every fixture must be torn down
// ---------------------------------------------------------------------------
//
// `createFixture` inserts a real `bumn`. Nothing ever removed it, so a suite
// run left ~1 new live reporting entity behind per fixture, forever, in a
// database no one truncates between runs.
//
// That is not a tidiness problem. `seed/index.ts` seeds the COA, the event
// mapping and the programme master PER BUMN, and
// `seed/event-jurnal.test.ts > every bumn present ends up with a full mapping
// set` sweeps every live entity to prove a deploy brings ALL of them to a
// postable state. Its cost is therefore linear in the number of live entities,
// and at ~2400 it crossed the 30s timeout. Narrowing the sweep would delete
// the only thing that test proves, so the fixtures have to stop leaking
// instead.
//
// The module worlds (modules/jurnal/test-support.ts,
// modules/nonpumk/test-support.ts) already close their own entity in `tutup()`
// this way. This is the same move for the harness.
//
// WHY SOFT DELETE, NOT CLEANUP. `bumn` is referenced by cabang, app_user,
// akun, jurnal and the rest; the ledger tables refuse a physical DELETE by
// design (tjsl_block_delete, migration 0002). Soft-deleting the entity is the
// system's own convention for "no longer live", it is what `bumnIds()` in
// seed/index.ts filters on, and it keeps every row available for a post-mortem.
// No assertion is weakened: a torn-down fixture is one whose tests have
// already finished.
//
// WHY A REGISTRY AND ONE `afterAll` PER FILE, NOT 96 try/finally BLOCKS.
// Fixtures are created inside individual `test()` bodies here, ~96 call sites.
// Wrapping each one would mean restructuring tests to fix a leak that is not
// theirs. Instead every fixture registers itself, and each test file adds a
// single `afterAll(tutupSemuaFixture)`. That also covers fixtures whose test
// threw, which a per-test teardown line would not.
//
// This is safe because `bun test` runs test files sequentially in one process
// (no concurrency is configured in bunfig.toml), so when a file's `afterAll`
// runs, the only fixtures in the registry are ones whose tests are done.

interface FixtureTerdaftar {
  db: DbPort;
  bumnId: string;
}

const fixtureAktif = new Set<FixtureTerdaftar>();

/**
 * Marks a test `bumn` as no longer live, the way the module worlds do.
 *
 * `deleted_by` is required to move with `deleted_at` (bumn_soft_delete_ck), and
 * it is an FK to app_user, so an actor has to be named. A user of this entity
 * is preferred; any user at all is accepted as a fallback, for the handful of
 * tests that insert a bare `bumn` with no users under it. If the database holds
 * no user whatsoever the statement is a no-op rather than a constraint
 * violation: teardown must never fail louder than the test it follows.
 */
export async function tandaiBumnUjiTerhapus(db: DbPort, bumnId: string): Promise<void> {
  await db.query(
    `UPDATE bumn b
        SET deleted_at = now(), deleted_by = u.id
       FROM (SELECT au.id
               FROM app_user au
               JOIN cabang c ON c.id = au.cabang_id
              ORDER BY (c.bumn_id = $1::uuid) DESC
              LIMIT 1) u
      WHERE b.id = $1::uuid AND b.deleted_at IS NULL`,
    [bumnId],
  );
}

/**
 * Tears down every fixture built so far in this process. Call it once per test
 * file: `afterAll(tutupSemuaFixture)`. Idempotent, and it never throws: a
 * teardown failure must not turn a green file red.
 */
export async function tutupSemuaFixture(): Promise<void> {
  const daftar = [...fixtureAktif];
  fixtureAktif.clear();
  for (const f of daftar) {
    try {
      await tandaiBumnUjiTerhapus(f.db, f.bumnId);
    } catch {
      // Deliberately swallowed. The database may have been truncated under us
      // by another agent's `db:reset`, in which case there is nothing to close.
    }
  }
}

let rbacSeeded: Promise<void> | undefined;

/**
 * Seeds the permission catalogue and the config capability keys, once per
 * process. Cheap and idempotent, so a `db:reset` from another agent only costs
 * the next fixture a re-seed.
 */
export async function ensureRbac(db: DbPort): Promise<void> {
  if (!rbacSeeded) {
    rbacSeeded = (async () => {
      await seedRbac(db);
      await seedKonfigurasiTambahan(db);
    })();
  }
  try {
    await rbacSeeded;
  } catch (err) {
    rbacSeeded = undefined;
    throw err;
  }
  // Cheap self-heal: if the tables were truncated after the memoised run, redo
  // it rather than fail every test in the file with "role not found".
  const rows = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM app_role");
  if (Number(rows[0]?.n ?? "0") === 0) {
    rbacSeeded = undefined;
    await ensureRbac(db);
  }
}

export interface FixtureOptions extends AppOverrides {
  clock?: TestClock;
  /** Roles to create users for. Defaults to all six. */
  roles?: readonly RoleCode[];
}

const ALL_ROLES: readonly RoleCode[] = [
  "MAKER",
  "CHECKER",
  "APPROVER",
  "ADMIN_CABANG",
  "ADMIN_PUSAT",
  "AUDITOR",
];

export async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const clock = options.clock ?? createTestClock();
  const suffix = crypto.randomUUID().slice(0, 8);

  const ctx = createApp({
    passwordOptions: FAST_PASSWORD_OPTIONS,
    // A namespace per fixture: the rate-limit counters and session keys of one
    // test file must never be visible to another, and Redis is real here.
    keyPrefix: `test:${suffix}`,
    ...options,
    // Merged AFTER the spread, not before: a caller passing its own
    // sessionOptions (TTLs) must not silently drop the injected clock, or
    // every expiry test would quietly assert nothing.
    sessionOptions: { now: clock.now, ...options.sessionOptions },
  });
  const db = ctx.db;

  await ensureRbac(db);

  const passwordHash = await ctx.auth.service.hashPassword(TEST_PASSWORD);

  const bumnRows = await db.query<{ id: string }>(
    `INSERT INTO bumn (kode, nama, tahun_buku_mulai_bulan)
     VALUES ($1, $2, 1) RETURNING id::text AS id`,
    [`T${suffix}`, `BUMN Uji ${suffix}`],
  );
  const bumnId = bumnRows[0]!.id;

  const mkCabang = async (kode: string, nama: string, isPusat: boolean): Promise<TestCabang> => {
    const rows = await db.query<{ id: string }>(
      `INSERT INTO cabang (bumn_id, kode, nama, is_pusat, aktif)
       VALUES ($1, $2, $3, $4, true) RETURNING id::text AS id`,
      [bumnId, kode, nama, isPusat],
    );
    return { id: rows[0]!.id, kode, nama };
  };

  const pusat = await mkCabang("00", `Pusat ${suffix}`, true);
  const cabangA = await mkCabang("01", `Cabang A ${suffix}`, false);
  const cabangB = await mkCabang("02", `Cabang B ${suffix}`, false);

  const mkUser = async (role: RoleCode, cabang: TestCabang, label: string): Promise<TestUser> => {
    const username = `${label}.${suffix}`;
    const rows = await db.query<{ id: string }>(
      `INSERT INTO app_user (cabang_id, nip, nama, email, username, password_hash, aktif)
       VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id::text AS id`,
      [cabang.id, `${label}-${suffix}`, `Uji ${role} ${suffix}`, `${username}@uji.local`, username, passwordHash],
    );
    const id = rows[0]!.id;
    await db.query(
      `INSERT INTO user_role (user_id, role_id)
       SELECT $1, id FROM app_role WHERE kode = $2 AND deleted_at IS NULL`,
      [id, role],
    );
    return { id, username, role, cabang };
  };

  const roles = options.roles ?? ALL_ROLES;
  const users = {} as Record<RoleCode, TestUser> & { MAKER_B: TestUser };
  for (const role of roles) {
    // Admin Pusat and Auditor sit at the head office, everyone else in
    // branch A: that is the layout spec 2 rule 3 describes.
    const cabang = role === "ADMIN_PUSAT" || role === "AUDITOR" ? pusat : cabangA;
    users[role] = await mkUser(role, cabang, role.toLowerCase());
  }
  // The cross-branch counterpart: same role, other branch.
  users.MAKER_B = await mkUser("MAKER", cabangB, "maker_b");

  const mkKaryawan = async (cabang: TestCabang): Promise<string> => {
    const rows = await db.query<{ id: string }>(
      `INSERT INTO karyawan (cabang_id, nip, nama, jabatan, unit, aktif)
       VALUES ($1, $2, $3, 'Petugas Survey', 'TJSL', true) RETURNING id::text AS id`,
      [cabang.id, `K-${cabang.kode}-${suffix}`, `Karyawan ${cabang.kode} ${suffix}`],
    );
    return rows[0]!.id;
  };

  const karyawanA = await mkKaryawan(cabangA);
  const karyawanB = await mkKaryawan(cabangB);

  const terdaftar: FixtureTerdaftar = { db, bumnId };
  fixtureAktif.add(terdaftar);
  const tutup = async (): Promise<void> => {
    fixtureAktif.delete(terdaftar);
    await tandaiBumnUjiTerhapus(db, bumnId);
  };

  const request = async (path: string, opts: RequestOptions = {}): Promise<Response> => {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${opts.cookie}`;
    if (opts.forwardedFor) headers["x-forwarded-for"] = opts.forwardedFor;
    const init: RequestInit = { method: opts.method ?? "GET", headers };
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    }
    // Built with the runtime's OWN Request, not the happy-dom one the suite
    // registers globally: happy-dom drops the Cookie header (see
    // ./native-fetch.ts), which would make every authenticated request in
    // every test silently anonymous.
    //
    // `app.fetch`, not `app.request`: the latter does `input instanceof
    // Request` against the CURRENT global (happy-dom's), which a native
    // Request fails, and then stringifies it into a 404. `fetch` takes the
    // request as given.
    const { Request: NativeRequest } = nativeFetchApi();
    return ctx.app.fetch(new NativeRequest(`http://localhost${path}`, init));
  };

  const tryLogin = (username: string, password: string, opts: RequestOptions = {}): Promise<Response> =>
    request("/auth/login", { ...opts, method: "POST", body: { username, password } });

  const login = async (username: string, password = TEST_PASSWORD): Promise<string> => {
    const res = await tryLogin(username, password);
    if (res.status !== 200) {
      throw new Error(`login ${username} gagal: ${res.status} ${await res.text()}`);
    }
    const cookie = extractSessionCookie(res);
    if (!cookie) throw new Error(`login ${username} tidak mengirim cookie ${SESSION_COOKIE}`);
    return cookie;
  };

  const auditRows = async (
    filter: { hasil?: "SUKSES" | "DITOLAK"; aksi?: string; userId?: string } = {},
  ): Promise<AuditRowLite[]> => {
    const ids = [...Object.values(users).map((u) => u.id)];
    return db.query<AuditRowLite>(
      `SELECT id::text AS id, user_id::text AS user_id, host(ip) AS ip, aksi, entitas, hasil,
              keterangan, nilai_lama_json, nilai_baru_json
         FROM audit_log
        WHERE ($1::text IS NULL OR hasil = $1)
          AND ($2::text IS NULL OR aksi = $2)
          AND ($3::uuid IS NULL OR user_id = $3)
          AND (user_id = ANY($4::uuid[]) OR user_id IS NULL)
        ORDER BY id DESC
        LIMIT 200`,
      [filter.hasil ?? null, filter.aksi ?? null, filter.userId ?? null, ids],
    );
  };

  return {
    ctx,
    db,
    suffix,
    bumnId,
    pusat,
    cabangA,
    cabangB,
    users,
    karyawanA,
    karyawanB,
    clock,
    login,
    tryLogin,
    request,
    auditRows,
    tutup,
  };
}

/** Pulls the session id out of a Set-Cookie header. */
export function extractSessionCookie(res: Response): string | null {
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  const match = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(raw);
  const value = match?.[1] ?? null;
  return value && value.length > 0 ? value : null;
}

/** Parsed attributes of the session Set-Cookie header, for policy assertions. */
export function sessionCookieAttributes(res: Response): Record<string, string | boolean> {
  const raw = res.headers.get("set-cookie") ?? "";
  const out: Record<string, string | boolean> = {};
  for (const part of raw.split(";").map((p) => p.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq < 0) out[part.toLowerCase()] = true;
    else out[part.slice(0, eq).toLowerCase()] = part.slice(eq + 1);
  }
  return out;
}

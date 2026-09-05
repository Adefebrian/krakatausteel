// Fixtures for modules/ai. PRIVATE to this folder.
//
// THE STUB IS THE WHOLE POINT OF THE PORT.
//
// `AiPort` exists so that no test in this repository ever needs a network or an
// API key. A suite that needs either is a suite that stops running: it fails on
// a laptop with no key, it fails in CI behind a proxy, and it fails at 3am
// because somebody else's provider had an incident. So every test here injects
// one of these, and `core/app.ts` only ever constructs the real adapter when
// `AI_ENABLED` is "true", which no test sets.
//
// The stub is also how the FAIL-OPEN promise is proved. A real provider cannot
// be asked to be slow, to return prose, to return an apology, or to throw a
// missing-key error on demand; this one can, and each of those is a test.
import type { AiPort, CompletionOptions } from "../../core/ports/ai";

export interface StubAiOptions {
  /** Fixed answer for every call. */
  jawaban?: string;
  /** Throw instead of answering, to stand in for an outage or a missing key. */
  gagal?: Error;
  /** Resolve after this many ms, to stand in for a provider that hangs. */
  tundaMs?: number;
  /** Reported model name. Defaults to the JAL default, since that is what ships. */
  model?: string;
}

export interface StubAi extends AiPort {
  /** Every prompt this stub was handed, in order. THE EVIDENCE FOR REDACTION. */
  readonly panggilan: { prompt: string; options: CompletionOptions | undefined }[];
}

/**
 * An `AiPort` that answers from a script.
 *
 * `panggilan` is what makes the personal-data promise testable end to end: a
 * test can run a document containing a NIK through the whole engine and then
 * assert that the exact bytes the port received do not contain it.
 */
export function stubAi(options: StubAiOptions = {}): StubAi {
  const panggilan: { prompt: string; options: CompletionOptions | undefined }[] = [];
  return {
    model: options.model ?? "gpt-4o-mini",
    panggilan,
    async complete(prompt: string, opts?: CompletionOptions): Promise<string> {
      panggilan.push({ prompt, options: opts });
      if (options.tundaMs !== undefined) {
        await new Promise((r) => setTimeout(r, options.tundaMs));
      }
      if (options.gagal) throw options.gagal;
      return options.jawaban ?? "{}";
    },
  };
}

/**
 * A limiter that always allows. Tests that are not ABOUT the ceiling use this,
 * so a fixture making twenty extraction calls is testing extraction rather than
 * testing Redis.
 */
export function pembatasLonggar() {
  return {
    consume: async () => ({ allowed: true, remaining: 999, retryAfterSeconds: 0 }),
    reset: async () => {},
  };
}

/** A limiter that refuses everything, for the ceiling test. */
export function pembatasHabis(retryAfterSeconds = 42) {
  return {
    consume: async () => ({ allowed: false, remaining: 0, retryAfterSeconds }),
    reset: async () => {},
  };
}

/**
 * A model answer in the shape ./ekstraksi.ts asks for. Written as a helper
 * rather than as a string literal per test so a change to the answer contract
 * is one edit, and so every test's fixture is visibly the same shape.
 */
export function jawabanModel(
  field: Record<string, { nilai: unknown; keyakinan?: number; kutipan?: string | null }>,
): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(field).map(([k, v]) => [
        k,
        { nilai: v.nilai, keyakinan: v.keyakinan ?? 0.9, kutipan: v.kutipan ?? null },
      ]),
    ),
  );
}

// ---------------------------------------------------------------------------
// A LEDGER WORTH SCANNING
// ---------------------------------------------------------------------------
//
// The anomaly rules read `v_ledger_baris`, so proving the SQL runs at all needs
// real POSTED journals with real history. They are built THROUGH THE JOURNAL
// ENGINE -- `buatJurnal` then `verifikasiJurnal` then `postingJurnal`, by three
// different users -- and never by inserting rows. Two reasons, and the second
// is the one that matters:
//
//   1. invariant 11: every journal goes through `postingEvent`/the engine, and
//      the posting-path trigger (migration 0020) refuses anything else. A
//      fixture that raw-inserted would need a `boundary-allow` exemption and
//      would be proving the rules against a ledger the system cannot produce.
//   2. The engine applies segregation of duties, period resolution and the
//      balance guard, so the world this builds is a world the application could
//      actually have reached.
//
// The engine comes from the FIXTURE'S OWN `createApp` (`f.ctx.jurnal`), not
// from a deep import into modules/jurnal: the composition root is the one place
// allowed to know two modules at once, and `tools/check-boundaries.ts` enforces
// that here as everywhere else.
import type { Fixture } from "../../testing/harness";
import { seedCoaDanEventMapping } from "../../seed/event-jurnal";

export interface PeriodeUji {
  id: string;
  tahun: number;
  bulan: number;
  tanggalMulai: string;
  tanggalAkhir: string;
}

export interface DuniaAi {
  akunKas: string;
  akunBeban: string;
  akunBebanLain: string;
  /** The month the scan runs over. */
  periodeScan: PeriodeUji;
  /** Every period created, oldest first. */
  periode: PeriodeUji[];
  /** Posts one balanced journal through the engine and returns its number. */
  posting(input: {
    tanggal: string;
    keterangan: string | null;
    jumlah: string;
    akunDebit: string;
    akunKredit: string;
  }): Promise<string>;
}

function akhirBulan(tahun: number, bulan: number): number {
  if (bulan === 2) return (tahun % 4 === 0 && tahun % 100 !== 0) || tahun % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(bulan) ? 30 : 31;
}

/**
 * Builds the COA, four consecutive OPEN monthly periods, and returns a
 * `posting` helper. The caller decides what the ledger looks like; this only
 * supplies the machinery.
 */
export async function buatDuniaAi(f: Fixture, tahun = 2026): Promise<DuniaAi> {
  const { akun } = await seedCoaDanEventMapping(f.db, f.bumnId, f.users.ADMIN_PUSAT.id);

  const periode: PeriodeUji[] = [];
  for (const bulan of [6, 7, 8, 9]) {
    const mulai = `${tahun}-${String(bulan).padStart(2, "0")}-01`;
    const akhir = `${tahun}-${String(bulan).padStart(2, "0")}-${akhirBulan(tahun, bulan)}`;
    const rows = await f.db.query<{ id: string }>(
      `INSERT INTO periode (bumn_id, tahun, bulan, tanggal_mulai, tanggal_akhir, status, created_by, updated_by)
       VALUES ($1::uuid, $2, $3, $4::date, $5::date, 'OPEN', $6::uuid, $6::uuid)
       RETURNING id::text AS id`,
      [f.bumnId, tahun, bulan, mulai, akhir, f.users.ADMIN_PUSAT.id],
    );
    periode.push({ id: rows[0]!.id, tahun, bulan, tanggalMulai: mulai, tanggalAkhir: akhir });
  }

  const jurnal = f.ctx.jurnal;
  const ctxFor = (userId: string, permissions: string[]) => ({
    userId,
    cabangId: f.cabangA.id,
    bumnId: f.bumnId,
    permissions,
    cabangDalamScope: [f.cabangA.id],
  });

  return {
    akunKas: akun.get("1.1.01")!,
    akunBeban: akun.get("5.1.01")!,
    akunBebanLain: akun.get("5.1.02")!,
    periodeScan: periode[3]!,
    periode,
    async posting(input) {
      const draft = await jurnal.buatJurnal(
        {
          cabangId: f.cabangA.id,
          jenis: "UMUM",
          tanggalTransaksi: input.tanggal,
          keterangan: input.keterangan,
          baris: [
            { akunId: input.akunDebit, debit: input.jumlah, kredit: "0.00" },
            { akunId: input.akunKredit, debit: "0.00", kredit: input.jumlah },
          ],
        },
        ctxFor(f.users.MAKER.id, ["jurnal.create"]),
      );
      await jurnal.verifikasiJurnal(
        draft.id,
        ctxFor(f.users.CHECKER.id, ["jurnal.verify"]),
      );
      const posted = await jurnal.postingJurnal(
        draft.id,
        ctxFor(f.users.APPROVER.id, ["jurnal.post"]),
      );
      return posted.noJurnal;
    },
  };
}

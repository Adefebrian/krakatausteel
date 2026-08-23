// Document-number generator (spec 4.10: "Harus aman dari race condition").
//
// HOW IT IS MADE SAFE
//   1. ensure the counter row exists (INSERT ... ON CONFLICT DO NOTHING)
//   2. BEGIN
//   3. SELECT ... FOR UPDATE on that one row
//   4. UPDATE urutan_terakhir = urutan_terakhir + 1 RETURNING
//   5. COMMIT
// Step 3 is the serialisation point: every other caller for the same series
// blocks on the row lock, so two callers can never read the same
// urutan_terakhir. The result is contiguous (no gaps) as well as unique, which
// matters here because a gap in an official document series is a question an
// auditor will ask.
//
// A pure `UPDATE ... RETURNING` would also be atomic and one round trip
// shorter, but a document number is usually allocated as part of a larger
// financial operation (create the proposal AND number it), and that operation
// owns a transaction already. Taking an explicit lock inside the caller's
// transaction is what makes "the number and the document commit together, or
// neither does" true. `generate(key, { tx })` exists for exactly that: pass
// the caller's runner and the number joins their transaction, so a rolled back
// proposal does not burn a number.
//
// WHY NOT A POSTGRES SEQUENCE. A sequence per (bumn, cabang, jenis, tahun,
// bulan) combination means creating DDL at runtime, sequences are not
// transactional (nextval is never rolled back, so gaps are guaranteed), and
// they cannot be reset per month without more DDL. The counter row is one
// row, in the same transaction as the document, with the format template
// living next to it.
import { AppError } from "../../core/http";
import { DEFAULT_FORMAT_TEMPLATE, formatNomor } from "./format";
import type { DbPort, QueryRunner } from "./ports";
import { createNomorRepo, type NomorRepo, type SeriKey } from "./repo";

export interface GenerateInput extends SeriKey {
  /** Rendered into the template as {kode_cabang}; "" for a pusat series. */
  kodeCabang?: string;
  kodeBumn?: string;
  /** Used only when the series row is created for the first time. */
  formatTemplate?: string;
  /** Recorded as created_by/updated_by on the counter row. */
  userId?: string | null;
}

export interface NomorHasil {
  nomor: string;
  urutan: number;
  formatTemplate: string;
}

export interface NomorService {
  /**
   * Allocates the next number in the series. Pass `tx` to join a caller's
   * transaction so the number and the document commit together.
   */
  generate(input: GenerateInput, options?: { tx?: QueryRunner }): Promise<NomorHasil>;
  /** Current counter value without consuming one. Never used to build a number. */
  peek(key: SeriKey): Promise<number | null>;
}

export interface NomorServiceDeps {
  db: DbPort;
  repo?: NomorRepo;
}

const JENIS_RE = /^[A-Z0-9_]{2,32}$/;

export function createNomorService({ db, repo = createNomorRepo() }: NomorServiceDeps): NomorService {
  function validate(input: GenerateInput): void {
    if (!JENIS_RE.test(input.jenisDokumen)) {
      throw new AppError(
        "VALIDASI",
        `jenis_dokumen "${input.jenisDokumen}" tidak valid (huruf besar, angka, garis bawah, 2..32 karakter)`,
      );
    }
    if (!Number.isInteger(input.tahun) || input.tahun < 1900 || input.tahun > 2200) {
      throw new AppError("VALIDASI", `tahun ${input.tahun} di luar rentang 1900..2200`);
    }
    if (input.bulan !== null && (!Number.isInteger(input.bulan) || input.bulan < 1 || input.bulan > 12)) {
      throw new AppError("VALIDASI", `bulan ${input.bulan} di luar rentang 1..12`);
    }
  }

  async function allocate(runner: QueryRunner, input: GenerateInput): Promise<NomorHasil> {
    const key: SeriKey = {
      bumnId: input.bumnId,
      cabangId: input.cabangId,
      jenisDokumen: input.jenisDokumen,
      tahun: input.tahun,
      bulan: input.bulan,
    };
    const locked = await repo.lock(runner, key);
    if (!locked) {
      // ensure() ran before the transaction, so the row must exist. If it does
      // not, something deleted it concurrently; say so instead of silently
      // starting a new series at 1 (which would duplicate numbers).
      throw new AppError(
        "KESALAHAN_SERVER",
        `Baris nomor_urut untuk ${input.jenisDokumen} ${input.tahun}/${input.bulan ?? "-"} tidak ditemukan setelah dibuat`,
      );
    }
    const urutan = await repo.increment(runner, locked.id, input.userId ?? null);
    return {
      nomor: formatNomor(locked.format_template, {
        urutan,
        tahun: input.tahun,
        bulan: input.bulan,
        jenisDokumen: input.jenisDokumen,
        kodeCabang: input.kodeCabang ?? "",
        kodeBumn: input.kodeBumn ?? "",
      }),
      urutan,
      formatTemplate: locked.format_template,
    };
  }

  return {
    async generate(input, options = {}) {
      validate(input);
      const template = input.formatTemplate ?? DEFAULT_FORMAT_TEMPLATE;
      // Rendered once with a throwaway sequence number so a bad template
      // fails BEFORE a counter row is created or a number is consumed.
      formatNomor(template, {
        urutan: 1,
        tahun: input.tahun,
        bulan: input.bulan,
        jenisDokumen: input.jenisDokumen,
        kodeCabang: input.kodeCabang ?? "",
        kodeBumn: input.kodeBumn ?? "",
      });

      // Outside the lock: creating the series must not be part of the
      // critical section, and ON CONFLICT DO NOTHING makes it idempotent.
      await repo.ensure(options.tx ?? db, input, template, input.userId ?? null);

      return options.tx ? allocate(options.tx, input) : db.transaction((tx) => allocate(tx, input));
    },

    async peek(key) {
      const row = await repo.peek(db, key);
      return row?.urutan_terakhir ?? null;
    },
  };
}

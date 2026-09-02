// Every SQL statement this module issues. Three driver facts govern the shapes
// below (they are stated at the top of modules/jurnal/repo.ts and each one has
// cost this project a debugging session):
//
//   - a JS array binds as a comma-joined string, so `= ANY($n::text[])` fails
//     with 22P02; explicit placeholders are used instead;
//   - a jsonb parameter bound from a JS string arrives as a JSON STRING
//     SCALAR, so it is written `$n::text::jsonb`;
//   - a DATE column comes back as a JS `Date`, so every date is selected
//     `::text`.
//
// ONE TABLE IS WRITTEN HERE AND ONLY ONE: `portal_submission`. There is no
// statement in this file that touches `mitra`, `pumk_proposal`, `jurnal` or
// anything else, which is what makes "a public form cannot create anything
// operational" a property of the code rather than a promise.
import type { QueryRunner } from "../../core/ports/db";
import type { JenisPengajuan, StatusSubmission } from "./contract";

export interface BarisEntitas {
  id: string;
  kode: string;
  nama: string;
}

export interface BarisSubmission {
  id: string;
  bumn_id: string;
  jenis: JenisPengajuan;
  no_tiket: string;
  tanggal_submit: string;
  data_json: string;
  dokumen_json: string;
  email_kontak: string | null;
  telepon_kontak: string | null;
  pemeriksa_hash: string | null;
  status: StatusSubmission;
  converted_proposal_id: string | null;
  catatan_petugas: string | null;
}

export interface BuatSubmissionInput {
  bumnId: string;
  jenis: JenisPengajuan;
  noTiket: string;
  dataJson: string;
  dokumenJson: string;
  emailKontak: string | null;
  teleponKontak: string | null;
  pemeriksaHash: string;
  ip: string | null;
  userAgent: string | null;
  /**
   * ISO timestamp. Taken from the engine's injectable clock rather than left
   * to the column default, so a generator that replays twenty four months
   * (apps/api/src/seed/demo-dunia) produces a queue with real dates on it
   * instead of twenty five rows all stamped "now".
   */
  tanggalSubmit: string;
}

export interface PortalRepo {
  entitasAktif(tx: QueryRunner, kode: string): Promise<BarisEntitas | null>;
  /** Submissions from one address in the last `jam` hours. Anti-spam, spec 9.5. */
  cacahPengajuanDariIp(tx: QueryRunner, ip: string, jam: number): Promise<number>;
  buatSubmission(tx: QueryRunner, input: BuatSubmissionInput): Promise<BarisSubmission>;
  /** The status-check lookup. Returns the hash so the engine can verify it. */
  submissionByTiket(tx: QueryRunner, noTiket: string): Promise<BarisSubmission | null>;
  catatPercobaanGagal(tx: QueryRunner, id: string): Promise<void>;
  submissionById(tx: QueryRunner, bumnId: string, id: string): Promise<BarisSubmission | null>;
  daftar(
    tx: QueryRunner,
    q: {
      bumnId: string;
      jenis: JenisPengajuan | null;
      status: StatusSubmission | null;
      noTiket: string | null;
      batas: number;
    },
  ): Promise<(BarisSubmission & { punya_proposal: boolean })[]>;
  tandai(
    tx: QueryRunner,
    input: { id: string; bumnId: string; status: StatusSubmission; catatan: string | null; userId: string },
  ): Promise<number>;
}

const KOLOM = `
  id::text as id, bumn_id::text as bumn_id, jenis, no_tiket,
  to_char(tanggal_submit, 'YYYY-MM-DD') as tanggal_submit,
  data_json::text as data_json, dokumen_json::text as dokumen_json,
  email_kontak, telepon_kontak, pemeriksa_hash, status,
  converted_proposal_id::text as converted_proposal_id, catatan_petugas`;

export function createPortalRepo(): PortalRepo {
  return {
    async entitasAktif(tx, kode) {
      const r = await tx.query<BarisEntitas>(
        `select id::text as id, kode, nama from bumn
          where kode = $1 and deleted_at is null limit 1`,
        [kode],
      );
      return r[0] ?? null;
    },

    async cacahPengajuanDariIp(tx, ip, jam) {
      // `portal_submission_ip_idx` (migrations/0013) exists for exactly this
      // query: "Rate limiting / anti-spam (spec 9.5) inspects recent
      // submissions per source."
      const r = await tx.query<{ n: string }>(
        `select count(*)::text as n from portal_submission
          where ip_submitter = $1::inet
            and tanggal_submit > now() - ($2::text || ' hours')::interval`,
        [ip, String(jam)],
      );
      return Number(r[0]?.n ?? "0");
    },

    async buatSubmission(tx, input) {
      const r = await tx.query<BarisSubmission>(
        `insert into portal_submission
           (bumn_id, jenis, no_tiket, tanggal_submit, data_json, dokumen_json,
            email_kontak, telepon_kontak, pemeriksa_hash, status, ip_submitter, user_agent)
         values ($1::uuid, $2, $3, $11::timestamptz, $4::text::jsonb, $5::text::jsonb,
                 $6, $7, $8, 'BARU', $9::inet, $10)
         returning ${KOLOM}`,
        [
          input.bumnId,
          input.jenis,
          input.noTiket,
          input.dataJson,
          input.dokumenJson,
          input.emailKontak,
          input.teleponKontak,
          input.pemeriksaHash,
          input.ip,
          input.userAgent,
          input.tanggalSubmit,
        ],
      );
      const baris = r[0];
      if (!baris) throw new Error("portal: insert submission tidak mengembalikan baris");
      return baris;
    },

    async submissionByTiket(tx, noTiket) {
      const r = await tx.query<BarisSubmission>(
        `select ${KOLOM} from portal_submission
          where no_tiket = $1 and deleted_at is null limit 1`,
        [noTiket],
      );
      return r[0] ?? null;
    },

    async catatPercobaanGagal(tx, id) {
      await tx.query(
        `update portal_submission
            set pemeriksa_percobaan = pemeriksa_percobaan + 1
          where id = $1::uuid`,
        [id],
      );
    },

    async submissionById(tx, bumnId, id) {
      // Scoped to the caller's entity IN THE QUERY: a staff caller from one
      // BUMN may not read another's queue by id, and the refusal is a
      // not-found rather than a 403 that confirms the row exists.
      const r = await tx.query<BarisSubmission>(
        `select ${KOLOM} from portal_submission
          where id = $1::uuid and bumn_id = $2::uuid and deleted_at is null limit 1`,
        [id, bumnId],
      );
      return r[0] ?? null;
    },

    async daftar(tx, q) {
      const params: unknown[] = [q.bumnId];
      const syarat = ["bumn_id = $1::uuid", "deleted_at is null"];
      if (q.jenis) {
        params.push(q.jenis);
        syarat.push(`jenis = $${params.length}`);
      }
      if (q.status) {
        params.push(q.status);
        syarat.push(`status = $${params.length}`);
      }
      if (q.noTiket) {
        params.push(q.noTiket);
        syarat.push(`no_tiket = $${params.length}`);
      }
      params.push(q.batas);
      return tx.query<BarisSubmission & { punya_proposal: boolean }>(
        `select ${KOLOM}, (converted_proposal_id is not null) as punya_proposal
           from portal_submission
          where ${syarat.join(" and ")}
          order by tanggal_submit desc, no_tiket desc
          limit $${params.length}`,
        params,
      );
    },

    async tandai(tx, input) {
      // Guarded on the CURRENT status inside the UPDATE as well as in the
      // engine, so two officers racing cannot both move a converted row.
      const r = await tx.query<{ id: string }>(
        `update portal_submission
            set status = $3, catatan_petugas = coalesce($4, catatan_petugas),
                updated_by = $5::uuid, updated_at = now()
          where id = $1::uuid and bumn_id = $2::uuid and deleted_at is null
            and status <> 'DIKONVERSI' and converted_proposal_id is null
        returning id::text as id`,
        [input.id, input.bumnId, input.status, input.catatan, input.userId],
      );
      return r.length;
    },
  };
}

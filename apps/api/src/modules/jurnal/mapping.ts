// ADMINISTERING `event_jurnal_mapping`, WITH A MAKER-CHECKER (ADR 0004,
// migration 0036).
//
// WHY THIS LIVES IN modules/jurnal AND NOT IN modules/konfigurasi.
// The table is this module's. `./service.ts` resolves every automatic journal's
// legs through it, `./repo.ts` is the only reader, and the closed set of event
// codes is this engine's vocabulary: an unknown event code is a bug here, not a
// configuration choice (ADR 0004's own words). Putting the editor next to the
// parameter screens would have made the module that DEPENDS on the mapping and
// the module that OWNS the mapping two different modules, with the owner unable
// to state what a valid event is.
//
// WHY A MAKER-CHECKER, AND NOT A SINGLE CLICK BEHIND A STRONG PERMISSION.
// A permission answers "may this person do it". It does not answer "did anyone
// else look". One row here decides what every future journal of an event debits
// and credits: repointing PENCAIRAN_PUMK's debit posts cleanly, balances, keeps
// every integrity check green, and quietly stops the entity having receivables.
// The demo world already produced one defect of exactly this class (the jasa
// administrasi misclassification, docs/RESUME.md) and forty-six green checks
// did not see it, because what was wrong was the classification and not the
// arithmetic. Arithmetic cannot be the control. A second pair of eyes can.
//
// WHY THE PERMISSION IS ITS OWN CODE.
// `konfigurasi.master` also gates sector names, provinces and the SDG list,
// which head office edits as routine data entry. Sharing a code would mean that
// granting somebody the right to rename a sector granted them the right to
// re-point the ledger. `konfigurasi.mapping` is separate for the same reason
// `jurnal.reversal` is not `jurnal.post`: the heavier act gets its own grant.
//
// WHY THE APPROVER NEEDS NO SECOND CODE.
// There is nothing above ADMIN_PUSAT in the role catalogue, so a second code
// would be held by exactly the same people and would buy nothing. The control
// with teeth is the PERSON: `diputus_by <> diajukan_by`, mirrored here and
// enforced by `trg_ejm_usulan_10_sod` in the database.
//
// WHAT THE ENGINE CAN SEE. Nothing in `event_jurnal_mapping_usulan`, ever. A
// pending proposal is a request, not a mapping in another state; the posting
// path reads only the active row in `event_jurnal_mapping`, which is why the
// proposal lives in its own table (see the migration header).
//
// WHERE THE EVENT VOCABULARY COMES FROM. The rows this entity already has, in
// any state. ADR 0004 makes seeding load-bearing -- an event with no mapping
// cannot post, and the seed asserts every spec 6.4 event has one -- so the seed
// is what introduces an event code and this API is what re-points it. That is
// the split the ADR describes: an unknown event is a bug, an unknown account is
// a configuration choice. It also means this file does not carry a second copy
// of the event catalogue that could drift from the seed's.
import { badRequest, conflict, forbidden, notFound, segregationOfDuties } from "../../core/http";
import type { Principal } from "../../core/principal";
import type { JurnalDbPort, JurnalTx } from "./ports";

/** The one permission this surface is behind. */
export const PERMISSION_MAPPING = "konfigurasi.mapping";

const POLA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_ALASAN = 10;
const JENIS_JURNAL = [
  "KAS_BANK",
  "UMUM",
  "PINBUK",
  "OTOMATIS",
  "PENYISIHAN",
  "AKRUAL",
  "REVERSAL",
  "CLOSING",
  "SALDO_AWAL",
] as const;

export interface MappingTampil {
  id: string;
  eventCode: string;
  akunDebitId: string | null;
  akunDebitKode: string | null;
  akunDebitNama: string | null;
  akunKreditId: string | null;
  akunKreditKode: string | null;
  akunKreditNama: string | null;
  debitDariPayload: boolean;
  kreditDariPayload: boolean;
  jenisJurnal: string;
  keterangan: string | null;
  aktif: boolean;
}

export interface UsulanTampil {
  id: string;
  eventCode: string;
  akunDebitId: string | null;
  akunDebitKode: string | null;
  akunKreditId: string | null;
  akunKreditKode: string | null;
  debitDariPayload: boolean;
  kreditDariPayload: boolean;
  jenisJurnal: string;
  alasan: string;
  status: string;
  mappingSebelum: unknown;
  diajukanBy: string;
  diajukanOleh: string | null;
  diajukanAt: string;
  diputusBy: string | null;
  diputusOleh: string | null;
  diputusAt: string | null;
  catatanKeputusan: string | null;
}

export interface AjukanMappingBody {
  eventCode: string;
  akunDebitId?: string | null;
  akunKreditId?: string | null;
  debitDariPayload?: boolean;
  kreditDariPayload?: boolean;
  jenisJurnal?: string;
  keterangan?: string | null;
  alasan: string;
}

export interface AuditMapping {
  record(
    entry: {
      userId?: string | null;
      aksi: string;
      entitas: string;
      entitasId?: string | null;
      nilaiLama?: unknown;
      nilaiBaru?: unknown;
      hasil: "SUKSES" | "DITOLAK";
      keterangan?: string | null;
    },
    runner?: JurnalTx,
  ): Promise<string>;
}

export interface MappingService {
  daftarBerlaku(principal: Principal): Promise<{ data: MappingTampil[]; tanpaPemetaan: string[] }>;
  daftarUsulan(principal: Principal, status?: string): Promise<UsulanTampil[]>;
  ajukan(principal: Principal, body: AjukanMappingBody): Promise<UsulanTampil>;
  setujui(principal: Principal, id: string, catatan: string | null): Promise<UsulanTampil>;
  tolak(principal: Principal, id: string, catatan: string | null): Promise<UsulanTampil>;
  batal(principal: Principal, id: string): Promise<UsulanTampil>;
}

interface MappingRow {
  id: string;
  event_code: string;
  akun_debit_id: string | null;
  akun_debit_kode: string | null;
  akun_debit_nama: string | null;
  akun_kredit_id: string | null;
  akun_kredit_kode: string | null;
  akun_kredit_nama: string | null;
  debit_dari_payload: boolean;
  kredit_dari_payload: boolean;
  jenis_jurnal: string;
  keterangan: string | null;
  aktif: boolean;
}

interface UsulanRow {
  id: string;
  bumn_id: string;
  event_code: string;
  akun_debit_id: string | null;
  akun_debit_kode: string | null;
  akun_kredit_id: string | null;
  akun_kredit_kode: string | null;
  debit_dari_payload: boolean;
  kredit_dari_payload: boolean;
  jenis_jurnal: string;
  keterangan: string | null;
  alasan: string;
  status: string;
  mapping_sebelum_json: unknown;
  diajukan_by: string;
  diajukan_oleh: string | null;
  diajukan_at: string;
  diputus_by: string | null;
  diputus_oleh: string | null;
  diputus_at: string | null;
  catatan_keputusan: string | null;
}

const KOLOM_MAPPING = `m.id::text AS id, m.event_code, m.akun_debit_id::text AS akun_debit_id,
  d.kode AS akun_debit_kode, d.nama AS akun_debit_nama,
  m.akun_kredit_id::text AS akun_kredit_id, k.kode AS akun_kredit_kode, k.nama AS akun_kredit_nama,
  m.debit_dari_payload, m.kredit_dari_payload, m.jenis_jurnal, m.keterangan, m.aktif`;

const FROM_MAPPING = `FROM event_jurnal_mapping m
  LEFT JOIN akun d ON d.id = m.akun_debit_id
  LEFT JOIN akun k ON k.id = m.akun_kredit_id`;

const KOLOM_USULAN = `u.id::text AS id, u.bumn_id::text AS bumn_id, u.event_code,
  u.akun_debit_id::text AS akun_debit_id, d.kode AS akun_debit_kode,
  u.akun_kredit_id::text AS akun_kredit_id, k.kode AS akun_kredit_kode,
  u.debit_dari_payload, u.kredit_dari_payload, u.jenis_jurnal, u.keterangan, u.alasan,
  u.status, u.mapping_sebelum_json, u.diajukan_by::text AS diajukan_by,
  pengusul.nama AS diajukan_oleh, u.diajukan_at::text AS diajukan_at,
  u.diputus_by::text AS diputus_by, pemutus.nama AS diputus_oleh,
  u.diputus_at::text AS diputus_at, u.catatan_keputusan`;

const FROM_USULAN = `FROM event_jurnal_mapping_usulan u
  LEFT JOIN akun d ON d.id = u.akun_debit_id
  LEFT JOIN akun k ON k.id = u.akun_kredit_id
  LEFT JOIN app_user pengusul ON pengusul.id = u.diajukan_by
  LEFT JOIN app_user pemutus ON pemutus.id = u.diputus_by`;

function tampilMapping(row: MappingRow): MappingTampil {
  return {
    id: row.id,
    eventCode: row.event_code,
    akunDebitId: row.akun_debit_id,
    akunDebitKode: row.akun_debit_kode,
    akunDebitNama: row.akun_debit_nama,
    akunKreditId: row.akun_kredit_id,
    akunKreditKode: row.akun_kredit_kode,
    akunKreditNama: row.akun_kredit_nama,
    debitDariPayload: row.debit_dari_payload,
    kreditDariPayload: row.kredit_dari_payload,
    jenisJurnal: row.jenis_jurnal,
    keterangan: row.keterangan,
    aktif: row.aktif,
  };
}

function tampilUsulan(row: UsulanRow): UsulanTampil {
  return {
    id: row.id,
    eventCode: row.event_code,
    akunDebitId: row.akun_debit_id,
    akunDebitKode: row.akun_debit_kode,
    akunKreditId: row.akun_kredit_id,
    akunKreditKode: row.akun_kredit_kode,
    debitDariPayload: row.debit_dari_payload,
    kreditDariPayload: row.kredit_dari_payload,
    jenisJurnal: row.jenis_jurnal,
    alasan: row.alasan,
    status: row.status,
    mappingSebelum: row.mapping_sebelum_json,
    diajukanBy: row.diajukan_by,
    diajukanOleh: row.diajukan_oleh,
    diajukanAt: row.diajukan_at,
    diputusBy: row.diputus_by,
    diputusOleh: row.diputus_oleh,
    diputusAt: row.diputus_at,
    catatanKeputusan: row.catatan_keputusan,
  };
}

export interface MappingServiceDeps {
  db: JurnalDbPort;
  audit: AuditMapping;
}

export function createMappingService({ db, audit }: MappingServiceDeps): MappingService {
  /** The active mapping for one event, or null. The engine reads the same row. */
  async function mappingAktif(
    tx: JurnalTx,
    bumnId: string,
    eventCode: string,
  ): Promise<MappingRow | null> {
    const rows = await tx.query<MappingRow>(
      `SELECT ${KOLOM_MAPPING} ${FROM_MAPPING}
        WHERE m.bumn_id = $1 AND m.event_code = $2 AND m.aktif AND m.deleted_at IS NULL
        LIMIT 1`,
      [bumnId, eventCode],
    );
    return rows[0] ?? null;
  }

  /**
   * A postable account of THIS entity, or a refusal.
   *
   * `event_jurnal_mapping.akun_{debit,kredit}_id` is a foreign key to
   * `akun(postable_id)` (ADR 0003), so a header account fails at the key with a
   * message naming `akun_postable_id_uq`. Checking here means the operator
   * reads which account and why instead of an index name, and it means the
   * refusal happens before the proposal row is written.
   */
  async function akunPostable(
    tx: JurnalTx,
    bumnId: string,
    id: string,
    field: string,
  ): Promise<{ id: string; kode: string }> {
    if (!POLA_UUID.test(id)) {
      throw badRequest("Format identitas akun tidak valid", { [field]: ["wajib berupa UUID"] });
    }
    const rows = await tx.query<{ id: string; kode: string; is_postable: boolean; aktif: boolean }>(
      `SELECT id::text AS id, kode, is_postable, aktif FROM akun
        WHERE id = $1 AND bumn_id = $2 AND deleted_at IS NULL`,
      [id, bumnId],
    );
    const row = rows[0];
    // Same 404 for "does not exist" and "belongs to another entity", so the
    // endpoint is not an oracle for ids it will not show.
    if (!row) throw notFound("Akun tidak ditemukan");
    if (!row.is_postable) {
      throw badRequest(
        `Akun ${row.kode} bukan akun postable, jadi tidak boleh menjadi kaki jurnal. ` +
          "Pemetaan event hanya boleh menunjuk akun daun yang menerima jurnal.",
        { [field]: [`akun ${row.kode} tidak postable`] },
      );
    }
    if (!row.aktif) {
      throw conflict(`Akun ${row.kode} sudah tidak aktif, jadi tidak boleh dijadikan kaki jurnal`);
    }
    return { id: row.id, kode: row.kode };
  }

  async function usulanById(tx: JurnalTx, principal: Principal, id: string): Promise<UsulanRow> {
    if (!POLA_UUID.test(id)) throw badRequest("Format identitas usulan tidak valid");
    const rows = await tx.query<UsulanRow>(
      `SELECT ${KOLOM_USULAN} ${FROM_USULAN} WHERE u.id = $1 AND u.deleted_at IS NULL FOR UPDATE OF u`,
      [id],
    );
    const row = rows[0];
    if (!row || row.bumn_id !== principal.bumnId) throw notFound("Usulan pemetaan tidak ditemukan");
    return row;
  }

  return {
    async daftarBerlaku(principal) {
      const rows = await db.query<MappingRow>(
        `SELECT ${KOLOM_MAPPING} ${FROM_MAPPING}
          WHERE m.bumn_id = $1 AND m.aktif AND m.deleted_at IS NULL
          ORDER BY m.event_code`,
        [principal.bumnId],
      );
      // The events this entity KNOWS (any mapping row, active or superseded)
      // minus the ones with a row in force. A non-empty answer here means an
      // event that can no longer post, which is the failure ADR 0004 warns
      // about and the reason the list is reported next to the mappings.
      const hilang = await db.query<{ event_code: string }>(
        `SELECT DISTINCT event_code
           FROM event_jurnal_mapping
          WHERE bumn_id = $1 AND deleted_at IS NULL
            AND event_code NOT IN (
              SELECT event_code FROM event_jurnal_mapping
               WHERE bumn_id = $1 AND aktif AND deleted_at IS NULL)
          ORDER BY event_code`,
        [principal.bumnId],
      );
      return {
        data: rows.map(tampilMapping),
        tanpaPemetaan: hilang.map((r) => r.event_code),
      };
    },

    async daftarUsulan(principal, status) {
      const rows = await db.query<UsulanRow>(
        `SELECT ${KOLOM_USULAN} ${FROM_USULAN}
          WHERE u.bumn_id = $1 AND u.deleted_at IS NULL
            AND ($2::text IS NULL OR u.status = $2)
          ORDER BY u.diajukan_at DESC
          LIMIT 200`,
        [principal.bumnId, status ?? null],
      );
      return rows.map(tampilUsulan);
    },

    async ajukan(principal, body) {
      const eventCode = typeof body.eventCode === "string" ? body.eventCode.trim().toUpperCase() : "";
      const alasan = typeof body.alasan === "string" ? body.alasan.trim() : "";
      const galat: Record<string, string[]> = {};
      if (eventCode.length === 0) galat.eventCode = ["wajib diisi"];
      if (alasan.length < MIN_ALASAN) {
        galat.alasan = [
          `wajib diisi, minimal ${MIN_ALASAN} karakter: baris pemetaan tidak menyimpan alasannya sendiri`,
        ];
      }
      const jenisJurnal = typeof body.jenisJurnal === "string" ? body.jenisJurnal : "OTOMATIS";
      if (!(JENIS_JURNAL as readonly string[]).includes(jenisJurnal)) {
        galat.jenisJurnal = [`harus salah satu dari: ${JENIS_JURNAL.join(", ")}`];
      }
      if (Object.keys(galat).length > 0) throw badRequest("Usulan pemetaan belum valid", galat);

      const debitDariPayload = body.debitDariPayload === true;
      const kreditDariPayload = body.kreditDariPayload === true;
      const debitId = typeof body.akunDebitId === "string" && body.akunDebitId.length > 0 ? body.akunDebitId : null;
      const kreditId =
        typeof body.akunKreditId === "string" && body.akunKreditId.length > 0 ? body.akunKreditId : null;

      // The three shape rules `event_jurnal_mapping` carries as CHECKs, said in
      // sentences. A leg is either an account or explicitly marked as supplied
      // by the caller at posting time; it is never simply absent, because the
      // engine reads `dariPayload ? payload.akun : row.akun` with no fallback
      // (see the note in seed/event-jurnal.ts).
      if (!debitDariPayload && debitId === null) {
        throw badRequest(
          "Kaki debit harus berupa akun, atau ditandai debitDariPayload kalau mesin jurnal yang " +
            "menentukannya saat posting.",
          { akunDebitId: ["wajib diisi kecuali debitDariPayload true"] },
        );
      }
      if (!kreditDariPayload && kreditId === null) {
        throw badRequest(
          "Kaki kredit harus berupa akun, atau ditandai kreditDariPayload kalau mesin jurnal yang " +
            "menentukannya saat posting.",
          { akunKreditId: ["wajib diisi kecuali kreditDariPayload true"] },
        );
      }
      if (debitId !== null && kreditId !== null && debitId === kreditId) {
        throw badRequest(
          "Kaki debit dan kaki kredit tidak boleh akun yang sama: jurnal seperti itu tidak " +
            "memindahkan apa pun.",
          { akunKreditId: ["harus berbeda dari akun debit"] },
        );
      }
      // An account stored next to a raised flag is a value nothing reads,
      // sitting where the wrong answer used to be. Refuse, do not quietly drop.
      if (debitDariPayload && debitId !== null) {
        throw badRequest(
          "debitDariPayload true berarti mesin jurnal yang memilih akun debit, jadi akunDebitId " +
            "harus dikosongkan.",
          { akunDebitId: ["harus kosong bila debitDariPayload true"] },
        );
      }
      if (kreditDariPayload && kreditId !== null) {
        throw badRequest(
          "kreditDariPayload true berarti mesin jurnal yang memilih akun kredit, jadi " +
            "akunKreditId harus dikosongkan.",
          { akunKreditId: ["harus kosong bila kreditDariPayload true"] },
        );
      }

      return db.transaction(async (tx) => {
        // THE EVENT VOCABULARY IS NOT OPEN. See the file header: the seed
        // introduces an event code, this API re-points it.
        const dikenal = await tx.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM event_jurnal_mapping
            WHERE bumn_id = $1 AND event_code = $2 AND deleted_at IS NULL`,
          [principal.bumnId, eventCode],
        );
        if (Number(dikenal[0]?.n ?? "0") === 0) {
          throw badRequest(
            `Event "${eventCode}" tidak dikenal mesin jurnal entitas ini. Kumpulan kode event ` +
              "adalah kode program, bukan data: yang boleh diubah adalah akun yang ditunjuknya.",
            { eventCode: ["event tidak dikenal"] },
          );
        }

        if (debitId !== null) await akunPostable(tx, principal.bumnId, debitId, "akunDebitId");
        if (kreditId !== null) await akunPostable(tx, principal.bumnId, kreditId, "akunKreditId");

        const terbuka = await tx.query<{ id: string }>(
          `SELECT id::text AS id FROM event_jurnal_mapping_usulan
            WHERE bumn_id = $1 AND event_code = $2 AND status = 'DIAJUKAN' AND deleted_at IS NULL`,
          [principal.bumnId, eventCode],
        );
        if (terbuka.length > 0) {
          throw conflict(
            `Sudah ada usulan yang menunggu keputusan untuk event ${eventCode}. Putuskan atau ` +
              "batalkan usulan itu lebih dulu.",
          );
        }

        const sebelum = await mappingAktif(tx, principal.bumnId, eventCode);
        const rows = await tx.query<{ id: string }>(
          `INSERT INTO event_jurnal_mapping_usulan
             (bumn_id, event_code, akun_debit_id, akun_kredit_id, debit_dari_payload,
              kredit_dari_payload, jenis_jurnal, keterangan, alasan, mapping_sebelum_json,
              diajukan_by, created_by, updated_by)
           -- $10::text::jsonb, not $10::jsonb: with a bun:sql-backed runner the
           -- latter stores the JSON as a string SCALAR. See modules/audit/repo.ts.
           VALUES ($1, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10::text::jsonb, $11, $11, $11)
           RETURNING id::text AS id`,
          [
            principal.bumnId,
            eventCode,
            debitId,
            kreditId,
            debitDariPayload,
            kreditDariPayload,
            jenisJurnal,
            typeof body.keterangan === "string" ? body.keterangan.slice(0, 500) : null,
            alasan.slice(0, 1000),
            sebelum ? JSON.stringify(tampilMapping(sebelum)) : null,
            principal.userId,
          ],
        );
        const id = rows[0]!.id;
        await audit.record(
          {
            userId: principal.userId,
            aksi: "jurnal.mapping.ajukan",
            entitas: "event_jurnal_mapping_usulan",
            entitasId: id,
            nilaiLama: sebelum ? tampilMapping(sebelum) : null,
            nilaiBaru: { eventCode, akunDebitId: debitId, akunKreditId: kreditId, jenisJurnal, alasan },
            hasil: "SUKSES",
            keterangan: `usulan perubahan pemetaan event ${eventCode} diajukan`,
          },
          tx,
        );
        return tampilUsulan(await usulanById(tx, principal, id));
      });
    },

    async setujui(principal, id, catatan) {
      return db.transaction(async (tx) => {
        const usulan = await usulanById(tx, principal, id);
        if (usulan.status !== "DIAJUKAN") {
          throw conflict(`Usulan ini sudah berstatus ${usulan.status} dan tidak dapat diputus lagi`);
        }
        // SPEC 2 RULES 1 AND 2, applied to a configuration row. Mirrored here
        // so the refusal is a 409 with a sentence and happens BEFORE any write;
        // `trg_ejm_usulan_10_sod` is the guarantee and stays (ADR 0002).
        if (usulan.diajukan_by === principal.userId) {
          throw segregationOfDuties(
            "Anda yang mengajukan perubahan pemetaan ini, jadi Anda tidak boleh menyetujuinya " +
              "sendiri. Perubahan pemetaan event menentukan jurnal setiap transaksi event itu, " +
              "sehingga wajib diputus oleh orang lain.",
          );
        }

        const sebelum = await mappingAktif(tx, principal.bumnId, usulan.event_code);

        // SUPERSEDE, DO NOT OVERWRITE (ADR 0004): the partial unique index
        // allows exactly one active row per event while every previous row
        // stays readable, because "which account did this event credit in July"
        // is a question an auditor asks and a row is the answer.
        if (sebelum) {
          await tx.query(
            `UPDATE event_jurnal_mapping SET aktif = false, updated_by = $2
              WHERE id = $1 AND deleted_at IS NULL`,
            [sebelum.id, principal.userId],
          );
        }
        const baru = await tx.query<{ id: string }>(
          `INSERT INTO event_jurnal_mapping
             (bumn_id, event_code, deskripsi, akun_debit_id, akun_kredit_id, debit_dari_payload,
              kredit_dari_payload, jenis_jurnal, aktif, keterangan, created_by, updated_by)
           VALUES ($1, $2, $3, $4::uuid, $5::uuid, $6, $7, $8, true, $9, $10, $10)
           RETURNING id::text AS id`,
          [
            principal.bumnId,
            usulan.event_code,
            usulan.keterangan,
            usulan.akun_debit_id,
            usulan.akun_kredit_id,
            usulan.debit_dari_payload,
            usulan.kredit_dari_payload,
            usulan.jenis_jurnal,
            `Diterapkan dari usulan ${usulan.id}: ${usulan.alasan}`,
            principal.userId,
          ],
        );
        const mappingId = baru[0]!.id;

        await tx.query(
          `UPDATE event_jurnal_mapping_usulan
              SET status = 'DISETUJUI', diputus_by = $2, diputus_at = now(),
                  catatan_keputusan = $3, diterapkan_mapping_id = $4::uuid, updated_by = $2
            WHERE id = $1`,
          [id, principal.userId, catatan, mappingId],
        );

        const sesudah = await mappingAktif(tx, principal.bumnId, usulan.event_code);
        await audit.record(
          {
            userId: principal.userId,
            aksi: "jurnal.mapping.setujui",
            entitas: "event_jurnal_mapping",
            entitasId: mappingId,
            nilaiLama: sebelum ? tampilMapping(sebelum) : null,
            nilaiBaru: sesudah ? tampilMapping(sesudah) : null,
            hasil: "SUKSES",
            keterangan:
              `pemetaan event ${usulan.event_code} diubah; diajukan oleh ${usulan.diajukan_by}, ` +
              `disetujui oleh ${principal.userId}. Alasan: ${usulan.alasan}`,
          },
          tx,
        );
        return tampilUsulan(await usulanById(tx, principal, id));
      });
    },

    async tolak(principal, id, catatan) {
      return db.transaction(async (tx) => {
        const usulan = await usulanById(tx, principal, id);
        if (usulan.status !== "DIAJUKAN") {
          throw conflict(`Usulan ini sudah berstatus ${usulan.status} dan tidak dapat diputus lagi`);
        }
        if (usulan.diajukan_by === principal.userId) {
          // Rejecting your own is harmless in effect, but it is still a
          // DECISION on your own filing, and the database refuses it anyway
          // (`diputus_by <> diajukan_by`). Withdraw it instead: `/batal`.
          throw segregationOfDuties(
            "Anda yang mengajukan usulan ini. Gunakan pembatalan untuk menarik usulan Anda sendiri.",
          );
        }
        await tx.query(
          `UPDATE event_jurnal_mapping_usulan
              SET status = 'DITOLAK', diputus_by = $2, diputus_at = now(),
                  catatan_keputusan = $3, updated_by = $2
            WHERE id = $1`,
          [id, principal.userId, catatan],
        );
        await audit.record(
          {
            userId: principal.userId,
            aksi: "jurnal.mapping.tolak",
            entitas: "event_jurnal_mapping_usulan",
            entitasId: id,
            nilaiLama: { status: "DIAJUKAN" },
            nilaiBaru: { status: "DITOLAK", catatan },
            hasil: "SUKSES",
            keterangan: `usulan pemetaan event ${usulan.event_code} ditolak`,
          },
          tx,
        );
        return tampilUsulan(await usulanById(tx, principal, id));
      });
    },

    async batal(principal, id) {
      return db.transaction(async (tx) => {
        const usulan = await usulanById(tx, principal, id);
        if (usulan.status !== "DIAJUKAN") {
          throw conflict(`Usulan ini sudah berstatus ${usulan.status} dan tidak dapat dibatalkan`);
        }
        // Withdrawal belongs to the author and to nobody else. Anyone else who
        // wants it gone rejects it, which leaves the refusal and its reason in
        // the record instead of making the request disappear.
        if (usulan.diajukan_by !== principal.userId) {
          throw forbidden(
            "Hanya pengusul yang boleh membatalkan usulannya sendiri. Pengguna lain menolaknya, " +
              "supaya keputusannya tercatat.",
          );
        }
        await tx.query(
          `UPDATE event_jurnal_mapping_usulan
              SET status = 'DIBATALKAN', dibatalkan_at = now(), updated_by = $2
            WHERE id = $1`,
          [id, principal.userId],
        );
        await audit.record(
          {
            userId: principal.userId,
            aksi: "jurnal.mapping.batal",
            entitas: "event_jurnal_mapping_usulan",
            entitasId: id,
            nilaiLama: { status: "DIAJUKAN" },
            nilaiBaru: { status: "DIBATALKAN" },
            hasil: "SUKSES",
            keterangan: `usulan pemetaan event ${usulan.event_code} ditarik oleh pengusulnya`,
          },
          tx,
        );
        return tampilUsulan(await usulanById(tx, principal, id));
      });
    },
  };
}

// THE ADMINISTRATION HALF of this module: the chart of accounts and the five
// master reference tables.
//
// WHAT MAKES THIS HARDER THAN CRUD, in one sentence per rule.
//
// A MASTER ROW IS REFERENCED BY POSTED HISTORY, so the operations split three
// ways and the split is per COLUMN, not per entity:
//
//   REFUSED OUTRIGHT   the identity a posted row refers back to: `akun.kode`,
//                      the code of any reference row, `akun.parent_id`,
//                      `akun.level`, `akun.tipe`. Changing one of these does
//                      not correct a mistake, it silently restates what an old
//                      journal meant. There is no version of that which is
//                      safe, so there is no endpoint for it. The remedy is a
//                      new row plus a deactivation, which leaves both readings
//                      available to whoever reads the history.
//
//   REFUSED WHILE USED `aktif = false` and `is_postable = false` on an account
//                      that an ACTIVE `event_jurnal_mapping` names, or that
//                      still has live children. The engines resolve their legs
//                      through that table (ADR 0004), so switching one off is
//                      not a config change, it is turning off a business event.
//
//   ALLOWED            the presentation and the classification: a name, a cash
//                      flow section, a report classification, `is_kas`,
//                      `is_kontra`, `urutan`. None of them moves a posted
//                      number; all of them are how an accountant keeps the
//                      chart readable. ADR 0004's whole argument is that this
//                      class of edit must not need a deploy.
//
// NOTHING HERE IS EVER DELETED. `akun` refuses physical DELETE at the database
// (0002 `tjsl_block_delete`, 0021 for TRUNCATE) and the reference tables would
// break foreign keys from proposals, grants and journals. Deactivation removes
// the row from every picker and leaves every historical read intact, which is
// exactly what "the past does not change" means in a chart of accounts.
//
// THE HIERARCHY IS CHECKED HERE, AHEAD OF `trg_akun_10_hierarki`. The trigger
// stays and is the guarantee (ADR 0002); this mirror exists so an operator
// reads "akun 1.1.01 sudah postable, jadi tidak boleh punya anak" instead of
// "TJSL-COA-004". Same split as modules/auth/segregation.ts, for the same three
// reasons it lists.
import { badRequest, conflict, notFound } from "../../core/http";
import type { AuditService } from "../audit";
import type { DbPort, Principal, QueryRunner } from "./ports";
import { definisiMaster, MASTER, type DefinisiMaster } from "./master";
import {
  createKonfigurasiAdminRepo,
  type AkunAdminRow,
  type BarisMaster,
  type KlasifikasiRow,
  type KonfigurasiAdminRepo,
} from "./admin-repo";

const POLA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLA_KODE_AKUN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,29}$/;
const TIPE_AKUN = ["ASET", "LIABILITAS", "ASET_NETO", "PENDAPATAN", "BEBAN"] as const;
const ARUS_KAS = ["OPERASI", "INVESTASI", "PENDANAAN"] as const;

export interface AkunTampil {
  id: string;
  kode: string;
  nama: string;
  parentId: string | null;
  parentKode: string | null;
  level: number;
  tipe: string;
  saldoNormal: "D" | "K";
  isPostable: boolean;
  isKas: boolean;
  isKontra: boolean;
  klasifikasiArusKas: string | null;
  klasifikasiAkun: string;
  aktif: boolean;
  version: number;
  /** Facts a screen needs to decide what to disable, so it never offers a 409. */
  punyaAnak: boolean;
  dipakaiMapping: boolean;
  dipakaiJurnal: boolean;
}

export interface BuatAkunBody {
  kode: string;
  nama: string;
  parentId?: string | null;
  level: number;
  tipe: string;
  saldoNormal: string;
  isPostable?: boolean;
  isKas?: boolean;
  isKontra?: boolean;
  klasifikasiArusKas?: string | null;
  klasifikasiAkun: string;
}

export interface UbahAkunBody {
  nama?: string | null;
  isKas?: boolean | null;
  isKontra?: boolean | null;
  isPostable?: boolean | null;
  klasifikasiArusKas?: string | null;
  klasifikasiAkun?: string | null;
  version?: number | null;
}

export interface KonfigurasiAdminService {
  listAkun(principal: Principal): Promise<AkunTampil[]>;
  getAkun(principal: Principal, id: string): Promise<AkunTampil>;
  buatAkun(principal: Principal, body: BuatAkunBody): Promise<AkunTampil>;
  ubahAkun(principal: Principal, id: string, body: UbahAkunBody): Promise<AkunTampil>;
  setAktifAkun(principal: Principal, id: string, aktif: boolean): Promise<AkunTampil>;
  listKlasifikasi(principal: Principal): Promise<KlasifikasiRow[]>;

  /** The registry itself, so a screen can render five lists from one contract. */
  daftarJenisMaster(): { jenis: string; label: string; scopeBumn: boolean }[];
  listMaster(principal: Principal, jenis: string): Promise<BarisMaster[]>;
  buatMaster(principal: Principal, jenis: string, body: Record<string, unknown>): Promise<BarisMaster>;
  ubahMaster(
    principal: Principal,
    jenis: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<BarisMaster>;
  setAktifMaster(
    principal: Principal,
    jenis: string,
    id: string,
    aktif: boolean,
  ): Promise<BarisMaster>;
}

export interface KonfigurasiAdminDeps {
  db: DbPort;
  audit: AuditService;
  adminRepo?: KonfigurasiAdminRepo;
}

function tampilAkun(row: AkunAdminRow): AkunTampil {
  return {
    id: row.id,
    kode: row.kode,
    nama: row.nama,
    parentId: row.parent_id,
    parentKode: row.parent_kode,
    level: row.level,
    tipe: row.tipe,
    saldoNormal: row.saldo_normal as "D" | "K",
    isPostable: row.is_postable,
    isKas: row.is_kas,
    isKontra: row.is_kontra,
    klasifikasiArusKas: row.klasifikasi_arus_kas,
    klasifikasiAkun: row.klasifikasi_akun,
    aktif: row.aktif,
    version: row.version,
    punyaAnak: row.punya_anak,
    dipakaiMapping: row.dipakai_mapping,
    dipakaiJurnal: row.dipakai_jurnal,
  };
}

function teks(nilai: unknown, maks: number): string | null {
  if (typeof nilai !== "string") return null;
  const bersih = nilai.trim();
  return bersih.length === 0 ? null : bersih.slice(0, maks);
}

export function createKonfigurasiAdminService({
  db,
  audit,
  adminRepo = createKonfigurasiAdminRepo(),
}: KonfigurasiAdminDeps): KonfigurasiAdminService {
  /** The account, pinned to the caller's entity. A stranger's id is a 404. */
  async function akunMilikEntitas(
    runner: QueryRunner,
    principal: Principal,
    id: string,
  ): Promise<AkunAdminRow> {
    if (!POLA_UUID.test(id)) throw badRequest("Format identitas akun tidak valid");
    const row = await adminRepo.findAkunById(runner, id);
    if (!row || row.bumn_id !== principal.bumnId) throw notFound("Akun tidak ditemukan");
    return row;
  }

  function jenisAtau404(jenis: string): DefinisiMaster {
    const def = definisiMaster(jenis);
    if (!def) {
      throw notFound(
        `Master "${jenis}" tidak dikenal. Yang tersedia: ${MASTER.map((d) => d.jenis).join(", ")}.`,
      );
    }
    return def;
  }

  /**
   * Validates a master body against its definition and returns the column
   * values. `lengkap` is false for a PATCH, where an omitted field means
   * "leave it alone" rather than "clear it".
   */
  async function nilaiMaster(
    runner: QueryRunner,
    def: DefinisiMaster,
    principal: Principal,
    body: Record<string, unknown>,
    lengkap: boolean,
  ): Promise<Record<string, unknown>> {
    const galat: Record<string, string[]> = {};
    const keluar: Record<string, unknown> = {};
    for (const f of def.fields) {
      const mentah = body[f.nama];
      if (mentah === undefined) {
        if (lengkap && f.wajib) galat[f.nama] = ["wajib diisi"];
        continue;
      }
      if (!lengkap && f.kunci) {
        // The key is what every posted row refers back to. Refused, not ignored.
        galat[f.nama] = ["tidak dapat diubah setelah dibuat"];
        continue;
      }
      switch (f.bentuk) {
        case "TEKS": {
          const nilai = teks(mentah, f.maks ?? 200);
          if (nilai === null) {
            if (f.wajib) galat[f.nama] = ["wajib diisi"];
            else keluar[f.nama] = null;
          } else {
            keluar[f.nama] = f.kunci ? nilai.toUpperCase() : nilai;
          }
          break;
        }
        case "ANGKA": {
          if (typeof mentah !== "number" || !Number.isInteger(mentah)) {
            galat[f.nama] = ["wajib bilangan bulat"];
          } else if ((f.min !== undefined && mentah < f.min) || (f.maks !== undefined && mentah > f.maks)) {
            galat[f.nama] = [`harus antara ${f.min ?? 0} dan ${f.maks ?? "?"}`];
          } else {
            keluar[f.nama] = mentah;
          }
          break;
        }
        case "ENUM": {
          if (typeof mentah !== "string" || !(f.pilihan ?? []).includes(mentah)) {
            galat[f.nama] = [`harus salah satu dari: ${(f.pilihan ?? []).join(", ")}`];
          } else {
            keluar[f.nama] = mentah;
          }
          break;
        }
        case "REF": {
          if (typeof mentah !== "string" || !POLA_UUID.test(mentah)) {
            galat[f.nama] = ["wajib berupa UUID"];
            break;
          }
          const ada = await adminRepo.refAda(
            runner,
            f.refTabel!,
            mentah,
            f.refScopeBumn ? principal.bumnId : null,
          );
          if (!ada) galat[f.nama] = ["referensi tidak ditemukan"];
          else keluar[f.nama] = mentah;
          break;
        }
      }
    }
    if (Object.keys(galat).length > 0) {
      throw badRequest(`Data ${def.label} belum valid`, galat);
    }
    return keluar;
  }

  return {
    async listAkun(principal) {
      return (await adminRepo.listAkun(db, principal.bumnId)).map(tampilAkun);
    },

    async getAkun(principal, id) {
      return tampilAkun(await akunMilikEntitas(db, principal, id));
    },

    async listKlasifikasi(principal) {
      return adminRepo.listKlasifikasi(db, principal.bumnId);
    },

    async buatAkun(principal, body) {
      const kode = teks(body.kode, 30);
      const nama = teks(body.nama, 200);
      const galat: Record<string, string[]> = {};
      if (!kode || !POLA_KODE_AKUN.test(kode)) {
        galat.kode = ["1 sampai 30 karakter, huruf, angka, titik, garis bawah atau strip"];
      }
      if (!nama) galat.nama = ["wajib diisi"];
      if (!Number.isInteger(body.level) || body.level < 1 || body.level > 6) {
        galat.level = ["harus bilangan bulat 1 sampai 6"];
      }
      if (!(TIPE_AKUN as readonly string[]).includes(body.tipe)) {
        galat.tipe = [`harus salah satu dari: ${TIPE_AKUN.join(", ")}`];
      }
      if (body.saldoNormal !== "D" && body.saldoNormal !== "K") {
        galat.saldoNormal = ["harus D atau K"];
      }
      const arusKas = teks(body.klasifikasiArusKas, 20);
      if (arusKas !== null && !(ARUS_KAS as readonly string[]).includes(arusKas)) {
        galat.klasifikasiArusKas = [`harus salah satu dari: ${ARUS_KAS.join(", ")}`];
      }
      const klasifikasi = teks(body.klasifikasiAkun, 50);
      if (!klasifikasi) galat.klasifikasiAkun = ["wajib diisi"];
      if (Object.keys(galat).length > 0) throw badRequest("Data akun belum valid", galat);

      const isPostable = body.isPostable === true;
      const isKas = body.isKas === true;
      // Thrown on their own rather than collected into the bucket above, so the
      // MESSAGE carries the rule. `akun_is_kas_hanya_aset_ck` refuses the same
      // thing at the database; an operator who trips it should read the reason,
      // not a constraint name and not a generic "data belum valid".
      if (isKas && body.tipe !== "ASET") {
        throw badRequest(
          `Hanya akun bertipe ASET yang boleh ditandai kas; akun ini bertipe ${body.tipe}. ` +
            "Saldo penutup Laporan Arus Kas didefinisikan sebagai jumlah akun kas, jadi sebuah " +
            "beban yang mengaku kas akan merusak laporan itu.",
          { isKas: ["hanya akun bertipe ASET yang boleh ditandai kas"] },
        );
      }
      if (isKas && !isPostable) {
        throw badRequest(
          "Akun kas harus postable: sebuah transaksi menunjuk akun kasnya secara langsung, dan " +
            "mesin jurnal menolak akun yang tidak postable.",
          { isKas: ["akun kas harus postable"] },
        );
      }

      const level = body.level;
      const parentId = typeof body.parentId === "string" && body.parentId.length > 0 ? body.parentId : null;

      return db.transaction(async (tx) => {
        if (await adminRepo.kodeAkunDipakai(tx, principal.bumnId, kode!)) {
          throw conflict(`Kode akun "${kode}" sudah dipakai di entitas ini`);
        }
        if (!(await adminRepo.klasifikasiAda(tx, principal.bumnId, klasifikasi!))) {
          throw badRequest("Klasifikasi akun tidak dikenal", {
            klasifikasiAkun: [`klasifikasi "${klasifikasi}" belum ada di entitas ini`],
          });
        }

        // --- the hierarchy, mirrored from trg_akun_10_hierarki -------------
        if (level === 1 && parentId !== null) {
          throw badRequest(
            "Akun level 1 adalah akar bagan akun dan tidak boleh punya parent.",
            { parentId: ["akun level 1 tidak boleh punya parent"] },
          );
        }
        if (level > 1 && parentId === null) {
          throw badRequest(
            `Akun level ${level} harus menggantung pada sebuah akun induk.`,
            { parentId: ["wajib diisi untuk akun di bawah level 1"] },
          );
        }
        if (parentId !== null) {
          const parent = await akunMilikEntitas(tx, principal, parentId);
          if (parent.is_postable) {
            throw badRequest(
              `Akun ${parent.kode} sudah bersifat postable, jadi tidak boleh punya akun anak. ` +
                "Hanya akun daun yang boleh menerima jurnal.",
              { parentId: ["akun induk tidak boleh postable"] },
            );
          }
          if (parent.level !== level - 1) {
            throw badRequest(
              `Level akun harus tepat satu di bawah induknya: induk ${parent.kode} ada di ` +
                `level ${parent.level}, jadi akun ini harus level ${parent.level + 1}, bukan ${level}.`,
              { level: [`harus ${parent.level + 1}`] },
            );
          }
          if (parent.tipe !== body.tipe) {
            throw badRequest(
              `Tipe akun harus sama dengan tipe induknya: induk ${parent.kode} bertipe ` +
                `${parent.tipe}, sedangkan akun ini ${body.tipe}.`,
              { tipe: [`harus ${parent.tipe}`] },
            );
          }
          if (!parent.aktif) {
            throw conflict(`Akun induk ${parent.kode} sudah tidak aktif`);
          }
        }

        const row = await adminRepo.insertAkun(tx, {
          bumnId: principal.bumnId,
          kode: kode!,
          nama: nama!,
          parentId,
          level,
          tipe: body.tipe,
          saldoNormal: body.saldoNormal,
          isPostable,
          isKas,
          isKontra: body.isKontra === true,
          klasifikasiArusKas: arusKas,
          klasifikasiAkun: klasifikasi!,
          userId: principal.userId,
        });
        await audit.record(
          {
            userId: principal.userId,
            aksi: "konfigurasi.akun.buat",
            entitas: "akun",
            entitasId: row.id,
            nilaiBaru: {
              kode: row.kode,
              nama: row.nama,
              tipe: row.tipe,
              level: row.level,
              parentId: row.parent_id,
              isPostable: row.is_postable,
              klasifikasiAkun: row.klasifikasi_akun,
            },
            hasil: "SUKSES",
            keterangan: "akun dibuat",
          },
          tx,
        );
        return tampilAkun(row);
      });
    },

    async ubahAkun(principal, id, body) {
      return db.transaction(async (tx) => {
        const sebelum = await akunMilikEntitas(tx, principal, id);

        const klasifikasi = teks(body.klasifikasiAkun, 50);
        if (klasifikasi && !(await adminRepo.klasifikasiAda(tx, principal.bumnId, klasifikasi))) {
          throw badRequest("Klasifikasi akun tidak dikenal", {
            klasifikasiAkun: [`klasifikasi "${klasifikasi}" belum ada di entitas ini`],
          });
        }
        const arusKas = teks(body.klasifikasiArusKas, 20);
        if (arusKas !== null && !(ARUS_KAS as readonly string[]).includes(arusKas)) {
          throw badRequest("Klasifikasi arus kas tidak dikenal", {
            klasifikasiArusKas: [`harus salah satu dari: ${ARUS_KAS.join(", ")}`],
          });
        }

        const isPostable = typeof body.isPostable === "boolean" ? body.isPostable : null;
        if (isPostable === false && sebelum.is_postable) {
          // WHY THIS IS A REFUSAL AND NOT A DATABASE ERROR.
          // `akun.postable_id` is a generated column that equals `id` while
          // `is_postable`, and both `jurnal_baris.akun_id` and
          // `event_jurnal_mapping.akun_{debit,kredit}_id` are real foreign keys
          // to it (ADR 0003). Clearing the flag makes the key those rows point
          // at disappear, so Postgres refuses with a foreign-key message naming
          // `akun_postable_id_uq`. That is the right outcome and an unreadable
          // sentence; these two checks say the same thing in the operator's
          // language, and name the event or the count.
          const events = await adminRepo.eventMappingUntukAkun(tx, id);
          if (events.length > 0) {
            throw conflict(
              `Akun ${sebelum.kode} masih dipakai oleh pemetaan event ${events.join(", ")}. ` +
                "Arahkan pemetaan itu ke akun lain lebih dulu.",
            );
          }
          if (sebelum.dipakai_jurnal) {
            throw conflict(
              `Akun ${sebelum.kode} sudah punya baris jurnal, jadi tidak dapat diubah menjadi ` +
                "non postable. Nonaktifkan akun ini kalau tidak boleh dipakai lagi.",
            );
          }
        }
        if (isPostable === true && sebelum.punya_anak) {
          throw conflict(
            `Akun ${sebelum.kode} masih punya akun anak, jadi tidak boleh dijadikan postable. ` +
              "Hanya akun daun yang menerima jurnal.",
          );
        }
        const isKas = typeof body.isKas === "boolean" ? body.isKas : null;
        if (isKas === true && sebelum.tipe !== "ASET") {
          throw badRequest("Hanya akun bertipe ASET yang boleh ditandai kas", {
            isKas: ["akun ini bukan ASET"],
          });
        }

        const sesudah = await adminRepo.updateAkun(tx, {
          id,
          nama: teks(body.nama, 200),
          isKas,
          isKontra: typeof body.isKontra === "boolean" ? body.isKontra : null,
          isPostable,
          klasifikasiArusKas: arusKas,
          klasifikasiAkun: klasifikasi,
          userId: principal.userId,
          version: typeof body.version === "number" ? body.version : null,
        });
        if (!sesudah) {
          throw conflict("Data akun sudah berubah sejak Anda membukanya. Muat ulang lalu ulangi.");
        }
        await audit.record(
          {
            userId: principal.userId,
            aksi: "konfigurasi.akun.ubah",
            entitas: "akun",
            entitasId: id,
            nilaiLama: {
              nama: sebelum.nama,
              isKas: sebelum.is_kas,
              isKontra: sebelum.is_kontra,
              isPostable: sebelum.is_postable,
              klasifikasiArusKas: sebelum.klasifikasi_arus_kas,
              klasifikasiAkun: sebelum.klasifikasi_akun,
            },
            nilaiBaru: {
              nama: sesudah.nama,
              isKas: sesudah.is_kas,
              isKontra: sesudah.is_kontra,
              isPostable: sesudah.is_postable,
              klasifikasiArusKas: sesudah.klasifikasi_arus_kas,
              klasifikasiAkun: sesudah.klasifikasi_akun,
            },
            hasil: "SUKSES",
            keterangan: "akun diubah",
          },
          tx,
        );
        return tampilAkun(sesudah);
      });
    },

    async setAktifAkun(principal, id, aktif) {
      return db.transaction(async (tx) => {
        const sebelum = await akunMilikEntitas(tx, principal, id);
        if (!aktif) {
          // THE PROTECTION THE BRIEF ASKS FOR, and it is stricter here than for
          // a sector name on purpose: a sector that stops being offered costs a
          // form one option, while an account the mapping points at stops
          // every future journal of that event from being postable at all.
          const events = await adminRepo.eventMappingUntukAkun(tx, id);
          if (events.length > 0) {
            throw conflict(
              `Akun ${sebelum.kode} adalah kaki dari pemetaan event ${events.join(", ")}, yang ` +
                "menentukan jurnal setiap transaksi event itu. Arahkan pemetaannya ke akun lain " +
                "lebih dulu, baru nonaktifkan akun ini.",
            );
          }
          if (sebelum.punya_anak) {
            throw conflict(
              `Akun ${sebelum.kode} masih punya akun anak yang aktif. Nonaktifkan turunannya ` +
                "lebih dulu, supaya tidak ada akun aktif yang menggantung pada induk mati.",
            );
          }
        }
        const sesudah = await adminRepo.setAktifAkun(tx, { id, aktif, userId: principal.userId });
        if (!sesudah) throw notFound("Akun tidak ditemukan");
        await audit.record(
          {
            userId: principal.userId,
            aksi: "konfigurasi.akun.status",
            entitas: "akun",
            entitasId: id,
            nilaiLama: { aktif: sebelum.aktif },
            nilaiBaru: { aktif },
            hasil: "SUKSES",
            keterangan: aktif ? `akun ${sebelum.kode} diaktifkan` : `akun ${sebelum.kode} dinonaktifkan`,
          },
          tx,
        );
        return tampilAkun(sesudah);
      });
    },

    // ------------------------------------------------------------- master
    daftarJenisMaster() {
      return MASTER.map((d) => ({ jenis: d.jenis, label: d.label, scopeBumn: d.scopeBumn }));
    },

    async listMaster(principal, jenis) {
      const def = jenisAtau404(jenis);
      return adminRepo.listMaster(db, def, principal.bumnId);
    },

    async buatMaster(principal, jenis, body) {
      const def = jenisAtau404(jenis);
      return db.transaction(async (tx) => {
        const nilai = await nilaiMaster(tx, def, principal, body, true);
        if (await adminRepo.masterKunciDipakai(tx, def, { nilai, bumnId: principal.bumnId, kecualiId: null })) {
          throw conflict(`${def.label} dengan kunci yang sama sudah ada`);
        }
        const row = await adminRepo.insertMaster(tx, def, {
          nilai,
          bumnId: principal.bumnId,
          userId: principal.userId,
        });
        await audit.record(
          {
            userId: principal.userId,
            aksi: "konfigurasi.master.buat",
            entitas: def.tabel,
            entitasId: row.id,
            nilaiBaru: row,
            hasil: "SUKSES",
            keterangan: `${def.label} dibuat`,
          },
          tx,
        );
        return row;
      });
    },

    async ubahMaster(principal, jenis, id, body) {
      const def = jenisAtau404(jenis);
      if (!POLA_UUID.test(id)) throw badRequest("Format identitas tidak valid");
      return db.transaction(async (tx) => {
        const sebelum = await adminRepo.findMasterById(tx, def, id, principal.bumnId);
        if (!sebelum) throw notFound(`${def.label} tidak ditemukan`);
        const nilai = await nilaiMaster(tx, def, principal, body, false);
        const sesudah = await adminRepo.updateMaster(tx, def, {
          id,
          nilai,
          bumnId: principal.bumnId,
          userId: principal.userId,
          version: typeof body.version === "number" ? body.version : null,
        });
        if (!sesudah) {
          throw conflict(`Data ${def.label} sudah berubah sejak Anda membukanya. Muat ulang lalu ulangi.`);
        }
        await audit.record(
          {
            userId: principal.userId,
            aksi: "konfigurasi.master.ubah",
            entitas: def.tabel,
            entitasId: id,
            nilaiLama: sebelum,
            nilaiBaru: sesudah,
            hasil: "SUKSES",
            keterangan: `${def.label} diubah`,
          },
          tx,
        );
        return sesudah;
      });
    },

    async setAktifMaster(principal, jenis, id, aktif) {
      const def = jenisAtau404(jenis);
      if (!POLA_UUID.test(id)) throw badRequest("Format identitas tidak valid");
      return db.transaction(async (tx) => {
        const sebelum = await adminRepo.findMasterById(tx, def, id, principal.bumnId);
        if (!sebelum) throw notFound(`${def.label} tidak ditemukan`);
        const sesudah = await adminRepo.setAktifMaster(tx, def, {
          id,
          aktif,
          bumnId: principal.bumnId,
          userId: principal.userId,
        });
        if (!sesudah) throw notFound(`${def.label} tidak ditemukan`);
        await audit.record(
          {
            userId: principal.userId,
            aksi: "konfigurasi.master.status",
            entitas: def.tabel,
            entitasId: id,
            nilaiLama: { aktif: sebelum.aktif },
            nilaiBaru: { aktif },
            hasil: "SUKSES",
            // DEACTIVATION, NEVER DELETION: the row keeps answering every
            // historical read (a proposal filed under this sector last year
            // still resolves it) and stops being offered to a new one.
            keterangan: aktif ? `${def.label} diaktifkan` : `${def.label} dinonaktifkan`,
          },
          tx,
        );
        return sesudah;
      });
    },
  };
}

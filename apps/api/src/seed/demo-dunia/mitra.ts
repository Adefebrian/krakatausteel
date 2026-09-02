// Mitra binaan and clusters.
//
// WHY THESE ROWS ARE WRITTEN DIRECTLY AND THE TRANSACTIONS ARE NOT
// `mitra` and `cluster` are master data: no module owns a create path for
// either (spec 9.6 files them under the master CRUD screens, which are not
// built yet), and neither table is a ledger table, so nothing is bypassed by
// inserting them. Cluster MEMBERSHIP is different and does go through the
// engine (`pumk.tambahAnggotaCluster`), because `cluster_anggota` is dated
// history the PUMK module owns and the cluster performance report reads.
import type { Dunia } from "./dunia";
import {
  BELAKANG,
  DEPAN_L,
  DEPAN_P,
  JENIS_USAHA,
  KECAMATAN,
  KELURAHAN,
  nikDemo,
  rp,
  tanggal,
  type Dadu,
} from "./acak";
import { DEMO_MITRA } from "../demo";

export interface MitraDemo {
  id: string;
  kode: string;
  nama: string;
  cabangKode: string;
  cabangId: string;
  sektorId: string;
  sektorKode: string;
  namaUsaha: string;
}

/** Spec 13: "sekitar 120 mitra dengan demografi bervariasi". */
export const JUMLAH_MITRA = 120;

/** How the 120 split across the three operational branches. */
const PORSI: Readonly<Record<string, number>> = { "01": 55, "02": 40, "03": 25 };

export async function pastikanMitra(dunia: Dunia, d: Dadu): Promise<MitraDemo[]> {
  const hasil: MitraDemo[] = [];
  const sektorPerKode = new Map(dunia.sektor.map((s) => [s.kode, s]));

  let urut = 0;
  for (const cab of dunia.cabang) {
    const jumlah = PORSI[cab.kode] ?? 0;
    for (let i = 0; i < jumlah; i += 1) {
      urut += 1;
      const laki = d.peluang(0.55);
      const nama = `${laki ? d.pilih(DEPAN_L) : d.pilih(DEPAN_P)} ${d.pilih(BELAKANG)}`;
      const usaha = d.pilih(JENIS_USAHA);
      const sektor = sektorPerKode.get(usaha.sektor) ?? dunia.sektor[0]!;
      const namaUsaha = `${d.pilih(usaha.nama)} ${nama.split(" ")[0]}`;
      const kota = d.pilih(dunia.kota);
      const lahir = tanggal(d.int(1968, 2000), d.int(1, 12), d.int(1, 28));

      // The first mitra of branch 01 is the account the portal login already
      // owns, so the public portal demo lands on a partner that actually has a
      // loan, a schedule and a payment history instead of an empty profile.
      const pakaiPortal = cab.kode === "01" && i === 0;
      const kode = pakaiPortal ? DEMO_MITRA.kodeMitra : `MTR-${cab.kode}-${(i + 1).toString().padStart(4, "0")}`;
      const namaFinal = pakaiPortal ? "Sumiati Rahayu" : nama;
      const usahaFinal = pakaiPortal ? DEMO_MITRA.nama : namaUsaha;

      const rows = await dunia.db.query<{ id: string }>(
        `INSERT INTO mitra (cabang_id, kode_mitra, nama_lengkap, nik, jenis_kelamin, tanggal_lahir,
                            alamat, kelurahan, kecamatan, kota_id, telepon, email,
                            nama_usaha, sektor_id, bidang_usaha, tahun_mulai_usaha,
                            jumlah_tenaga_kerja, omzet_bulanan, aset_usaha, status, aktif)
         VALUES ($1::uuid, $2, $3, $4, $5, $6::date, $7, $8, $9, $10::uuid, $11, $12,
                 $13, $14::uuid, $15, $16::int, $17::int, $18::numeric, $19::numeric, 'CALON', true)
         ON CONFLICT (kode_mitra) WHERE deleted_at IS NULL
         DO UPDATE SET nama_lengkap = EXCLUDED.nama_lengkap,
                       nik = EXCLUDED.nik,
                       jenis_kelamin = EXCLUDED.jenis_kelamin,
                       tanggal_lahir = EXCLUDED.tanggal_lahir,
                       alamat = EXCLUDED.alamat,
                       kelurahan = EXCLUDED.kelurahan,
                       kecamatan = EXCLUDED.kecamatan,
                       kota_id = EXCLUDED.kota_id,
                       nama_usaha = EXCLUDED.nama_usaha,
                       sektor_id = EXCLUDED.sektor_id,
                       bidang_usaha = EXCLUDED.bidang_usaha,
                       tahun_mulai_usaha = EXCLUDED.tahun_mulai_usaha,
                       jumlah_tenaga_kerja = EXCLUDED.jumlah_tenaga_kerja,
                       omzet_bulanan = EXCLUDED.omzet_bulanan,
                       aset_usaha = EXCLUDED.aset_usaha
         RETURNING id::text AS id`,
        [
          cab.id,
          kode,
          namaFinal,
          nikDemo(urut),
          laki ? "L" : "P",
          lahir,
          `Kp. ${d.pilih(KELURAHAN)} RT ${d.int(1, 12).toString().padStart(2, "0")}/RW ${d
            .int(1, 8)
            .toString()
            .padStart(2, "0")}`,
          d.pilih(KELURAHAN),
          d.pilih(KECAMATAN),
          kota.id,
          `08${d.int(11, 89)}${d.int(1000000, 9999999)}`,
          pakaiPortal ? DEMO_MITRA.email : null,
          usahaFinal,
          sektor.id,
          sektor.nama,
          d.int(2005, 2024),
          d.int(1, 12),
          rp(d.int(4, 60) * 1_000_000),
          rp(d.int(10, 250) * 1_000_000),
        ],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error(`seed demo: mitra ${kode} gagal dibuat`);
      hasil.push({
        id,
        kode,
        nama: namaFinal,
        cabangKode: cab.kode,
        cabangId: cab.id,
        sektorId: sektor.id,
        sektorKode: sektor.kode,
        namaUsaha: usahaFinal,
      });
    }
  }

  if (hasil.length !== JUMLAH_MITRA) {
    throw new Error(`seed demo: porsi mitra per cabang berjumlah ${hasil.length}, bukan ${JUMLAH_MITRA}`);
  }
  return hasil;
}

export interface ClusterDemo {
  id: string;
  kode: string;
  nama: string;
  cabangKode: string;
}

const CLUSTER: ReadonlyArray<{ cabang: string; kode: string; nama: string; sektor: string }> = [
  { cabang: "01", kode: "CLS-01-01", nama: "Sentra Konveksi Jombang", sektor: "IND" },
  { cabang: "01", kode: "CLS-01-02", nama: "Paguyuban Warung Ciwaduk", sektor: "DAG" },
  { cabang: "01", kode: "CLS-01-03", nama: "Kelompok Budidaya Lele Grogol", sektor: "KAN" },
  { cabang: "02", kode: "CLS-02-01", nama: "Kelompok Tani Kramatwatu", sektor: "TAN" },
  { cabang: "02", kode: "CLS-02-02", nama: "Sentra Ternak Ayam Cipocok", sektor: "NAK" },
  { cabang: "02", kode: "CLS-02-03", nama: "Koperasi Jasa Serang Kota", sektor: "JAS" },
  { cabang: "03", kode: "CLS-03-01", nama: "Nelayan Pesisir Anyer", sektor: "KAN" },
  { cabang: "03", kode: "CLS-03-02", nama: "Kebun Kelapa Cinangka", sektor: "BUN" },
];

/** Spec 13: 8 clusters. Membership is added through the PUMK engine. */
export async function pastikanCluster(
  dunia: Dunia,
  mitra: readonly MitraDemo[],
  tanggalMasuk: string,
): Promise<ClusterDemo[]> {
  const sektorPerKode = new Map(dunia.sektor.map((s) => [s.kode, s]));
  const hasil: ClusterDemo[] = [];

  for (const c of CLUSTER) {
    const cab = dunia.semuaCabang[c.cabang];
    if (!cab) continue;
    const rows = await dunia.db.query<{ id: string }>(
      `INSERT INTO cluster (cabang_id, kode, nama, sektor_id, keterangan, aktif)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, true)
       ON CONFLICT (cabang_id, kode) WHERE deleted_at IS NULL
       DO UPDATE SET nama = EXCLUDED.nama, sektor_id = EXCLUDED.sektor_id
       RETURNING id::text AS id`,
      [cab.id, c.kode, c.nama, sektorPerKode.get(c.sektor)?.id ?? null, "Kelompok binaan demo"],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error(`seed demo: cluster ${c.kode} gagal dibuat`);
    hasil.push({ id, kode: c.kode, nama: c.nama, cabangKode: c.cabang });
  }

  // Membership THROUGH THE ENGINE, as `pumk.cluster` and dated history demand.
  // Admin Pusat holds the code and every branch is in its scope.
  const ctx = dunia.ctx(dunia.adminPusat);
  dunia.jam.ke(tanggalMasuk);

  // Whoever is already a member stays a member. `tambahAnggotaCluster` refuses
  // a duplicate with MITRA_SUDAH_DI_CLUSTER, which is correct behaviour and
  // would otherwise make a second run of this seed fail on a database that
  // already has rosters.
  const anggotaAda = await dunia.db.query<{ mitra_id: string }>(
    `SELECT DISTINCT mitra_id::text AS mitra_id FROM cluster_anggota
      WHERE tanggal_keluar IS NULL AND deleted_at IS NULL`,
  );
  const sudah = new Set<string>(anggotaAda.map((a) => a.mitra_id));

  for (const cluster of hasil) {
    const kandidat = mitra.filter(
      (m) => m.cabangKode === cluster.cabangKode && !sudah.has(m.id),
    );
    for (const m of kandidat.slice(0, 8)) {
      await dunia.pumk.tambahAnggotaCluster(
        { clusterId: cluster.id, mitraId: m.id, tanggalMasuk },
        ctx,
      );
      sudah.add(m.id);
    }
  }
  return hasil;
}

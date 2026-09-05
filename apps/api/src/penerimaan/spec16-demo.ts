// SPEC 16 SCENARIOS 14..22, RE-RUN AGAINST THE 24-MONTH DEMO WORLD.
//
// WHY THIS IS A SCRIPT AND NOT A `*.test.ts`.
// ./spec16.test.ts builds its own world from nothing, so it runs on a bare test
// database and belongs in `bun test`. The figures it reads are therefore small:
// three loans, one grant, six closed months. That is enough to prove an
// identity holds; it is not enough to believe the reports would survive a real
// portfolio. This file reads the SAME scenarios off the world
// `bun run db:seed:demo` builds -- 120 mitra, 90 disbursed akad, 760 receipts,
// 24 periods with 23 closed -- which is a far better witness and which no gate
// can depend on, because a plain `bun run db:reset && bun test` has no demo
// world in it. Making it a test file would make the repository's own gate
// depend on a 15-second seed nobody asked for.
//
// RUN:
//   bun run db:reset && bun run db:seed && bun run db:seed:demo
//   DATABASE_URL="$TEST_DATABASE_URL" bun apps/api/src/penerimaan/spec16-demo.ts
//
// It prints one line per reading and exits non-zero if any check fails, so it
// is usable as a gate on a demo host even though it is not one here.
import { createApp } from "../core/app";
import { SESSION_COOKIE } from "../modules/auth";

const ctx = createApp({ keyPrefix: `spec16demo:${crypto.randomUUID().slice(0, 8)}` });
const SANDI = "TjslDemo#2026";

let gagal = 0;
function periksa(nama: string, lulus: boolean, bacaan: string): void {
  if (!lulus) gagal += 1;
  // eslint-disable-next-line no-console
  console.log(`  ${lulus ? "PASS" : "GAGAL"}  ${nama} :: ${bacaan}`);
}

async function req(path: string, cookie?: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (cookie) headers.cookie = `${SESSION_COOKIE}=${cookie}`;
  if (init.body) headers["content-type"] = "application/json";
  return ctx.app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
}

async function login(username: string): Promise<string> {
  const res = await req("/auth/login", undefined, {
    method: "POST",
    body: JSON.stringify({ username, password: SANDI }),
  });
  if (res.status !== 200) throw new Error(`login ${username}: ${res.status} ${await res.text()}`);
  const m = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(res.headers.get("set-cookie") ?? "");
  if (!m) throw new Error(`login ${username}: tidak ada cookie`);
  return m[1]!;
}

async function ambil<T>(path: string, cookie: string): Promise<T> {
  const res = await req(path, cookie);
  if (res.status !== 200) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

interface Angka {
  nilai: string;
  tampil: string;
}

const auditor = await login("auditor");
const adminPusat = await login("adminpusat");

const periode = await ambil<{ data: Array<{ id: string; tahun: number; bulan: number; status: string }> }>(
  "/laporan/periode",
  auditor,
);
const tertutup = periode.data.find((p) => p.status === "CLOSED");
if (!tertutup) throw new Error("dunia demo belum ada: tidak ada satu pun periode CLOSED");
const label = `${tertutup.tahun}-${String(tertutup.bulan).padStart(2, "0")}`;
// eslint-disable-next-line no-console
console.log(`\nDunia demo, periode CLOSED terakhir ${label}\n`);

// --- 14 ---------------------------------------------------------------------
const posisi = await ambil<{
  header: { sumberData: string };
  totalAsetTahunIni: Angka;
  totalLiabilitasTahunIni: Angka;
  totalAsetNetoTahunIni: Angka;
  totalLiabilitasDanAsetNetoTahunIni: Angka;
  kasDanSetaraKasTahunIni: Angka;
}>(`/laporan/posisi-keuangan?periodeId=${tertutup.id}`, auditor);
periksa(
  "14 Total Aset = Total Liabilitas + Aset Neto",
  posisi.totalAsetTahunIni.nilai === posisi.totalLiabilitasDanAsetNetoTahunIni.nilai,
  `aset ${posisi.totalAsetTahunIni.tampil} vs liabilitas+aset neto ${posisi.totalLiabilitasDanAsetNetoTahunIni.tampil} (sumber ${posisi.header.sumberData})`,
);

// --- 15 ---------------------------------------------------------------------
const arus = await ambil<{ kasAkhirTahunIni: Angka }>(
  `/laporan/arus-kas?periodeId=${tertutup.id}`,
  auditor,
);
periksa(
  "15 Kas Akhir = Kas dan Setara Kas di Laporan Posisi Keuangan",
  arus.kasAkhirTahunIni.nilai === posisi.kasDanSetaraKasTahunIni.nilai,
  `arus kas ${arus.kasAkhirTahunIni.tampil} vs posisi ${posisi.kasDanSetaraKasTahunIni.tampil}`,
);

// --- 16 ---------------------------------------------------------------------
const neraca = await ambil<{
  baris: unknown[];
  total: Record<string, Angka>;
}>(`/laporan/neraca-lajur?periodeId=${tertutup.id}`, auditor);
const t = neraca.total;
periksa(
  "16 Neraca Lajur, ketiga pasang kolom balance",
  t.saldoAwalDebit!.nilai === t.saldoAwalKredit!.nilai &&
    t.mutasiDebit!.nilai === t.mutasiKredit!.nilai &&
    t.saldoAkhirDebit!.nilai === t.saldoAkhirKredit!.nilai,
  `${neraca.baris.length} akun; awal ${t.saldoAwalDebit!.tampil}, mutasi ${t.mutasiDebit!.tampil}, akhir ${t.saldoAkhirDebit!.tampil}`,
);

// --- 17 ---------------------------------------------------------------------
const penyisihan = await ambil<{
  total: { jumlahAkad: number; nilaiPenyisihan: Angka };
  penyisihanDibutuhkanRun: Angka;
  selisihTerhadapRun: Angka;
}>(`/laporan/perhitungan-penyisihan?periodeId=${tertutup.id}`, adminPusat);
periksa(
  "17 Perhitungan Penyisihan merekonstruksi nilai jurnal penyisihan periode itu",
  penyisihan.selisihTerhadapRun.nilai === "0.00" &&
    Number(penyisihan.total.nilaiPenyisihan.nilai) > 0,
  `${penyisihan.total.jumlahAkad} akad, penyisihan ${penyisihan.total.nilaiPenyisihan.tampil}, selisih terhadap run ${penyisihan.selisihTerhadapRun.tampil}`,
);

// --- 18 ---------------------------------------------------------------------
const rka = await ambil<{
  statusRka: string;
  versi: number;
  total: { anggaran: string; realisasi: string };
  baris: Array<{ sumberRealisasi: string }>;
}>(
  `/rka/laporan/realisasi?tahun=${tertutup.tahun}&jenis=PUMK&mode=BULANAN&bulan=${tertutup.bulan}`,
  adminPusat,
);
const penyaluran = await ambil<{ totalKeseluruhan: { nilai: Angka; jumlahMitra: number } }>(
  `/laporan/penyaluran-nasional?periodeId=${tertutup.id}&mode=BULANAN`,
  adminPusat,
);
periksa(
  "18 RKA vs Realisasi cocok dengan total Laporan Penyaluran Nasional",
  rka.total.realisasi === penyaluran.totalKeseluruhan.nilai.nilai,
  `RKA v${rka.versi} ${rka.statusRka} realisasi ${rka.total.realisasi} vs penyaluran ${penyaluran.totalKeseluruhan.nilai.nilai} (${penyaluran.totalKeseluruhan.jumlahMitra} mitra), sumber ${rka.baris[0]?.sumberRealisasi ?? "-"}`,
);

// --- 19 ---------------------------------------------------------------------
const rekon = await ambil<{
  cocok: boolean;
  jumlahAkadDiperiksa: number;
  jumlahAkadSelisih: number;
  totalSubLedger: string;
  totalBukuBesar: string;
  totalSelisih: string;
}>("/tools/rekonsiliasi/piutang", adminPusat);
periksa(
  "19 Tools Rekonsiliasi, sub ledger piutang = buku besar, selisih nol",
  rekon.cocok && rekon.totalSelisih === "0.00" && rekon.jumlahAkadSelisih === 0,
  `${rekon.jumlahAkadDiperiksa} akad, sub ledger ${rekon.totalSubLedger}, buku besar ${rekon.totalBukuBesar}, selisih ${rekon.totalSelisih}`,
);
const rekonAuditor = await req("/tools/rekonsiliasi/piutang", auditor);
periksa(
  "19b TEMUAN: Tools Rekonsiliasi tertutup untuk Auditor",
  rekonAuditor.status === 403,
  `Auditor -> ${rekonAuditor.status} (tools.rekonsiliasi tidak ada di READ_ONLY)`,
);

// --- 20 ---------------------------------------------------------------------
const lima: Array<[string, string]> = [
  ["POSISI_KEUANGAN", `periodeId=${tertutup.id}`],
  ["ARUS_KAS", `periodeId=${tertutup.id}`],
  ["NERACA_LAJUR", `periodeId=${tertutup.id}`],
  ["PERHITUNGAN_PENYISIHAN", `periodeId=${tertutup.id}`],
  ["PENERIMAAN_ANGSURAN", `periodeId=${tertutup.id}&mode=BULANAN`],
];
for (const [kode, filter] of lima) {
  const xlsx = await req(`/laporan/ekspor/${kode}?${filter}&format=xlsx`, auditor);
  const isi = new Uint8Array(await xlsx.arrayBuffer());
  periksa(
    `20 ekspor ${kode} ke Excel`,
    xlsx.status === 200 && isi[0] === 0x50 && isi[1] === 0x4b && isi.byteLength > 1000,
    `${xlsx.status}, ${isi.byteLength} byte, magic ${isi[0]?.toString(16)}${isi[1]?.toString(16)}`,
  );
}
const pdf = await req(`/laporan/ekspor/POSISI_KEUANGAN?periodeId=${tertutup.id}&format=pdf`, auditor);
periksa(
  "20 ekspor ke PDF",
  pdf.status === 200,
  pdf.status === 200
    ? "200, PDF dihasilkan"
    : `${pdf.status} ${(((await pdf.json()) as { kodeDomain?: string }).kodeDomain) ?? ""} (CHROMIUM_PATH tidak diset)`,
);

// --- 20b, the half of scenario 20 that fails --------------------------------
const katalog = await ambil<{ data: Array<{ nomor: number; kode: string }> }>(
  "/laporan/katalog",
  auditor,
);
const rusak: string[] = [];
let diekspor = 0;
for (const e of katalog.data) {
  const tambahan =
    e.kode === "BUKU_BESAR"
      ? `&akunId=${(await ambil<{ baris: Array<{ akunId: string }> }>("/laporan/bagan-akun", auditor)).baris[0]?.akunId ?? ""}`
      : e.kode === "JATUH_TEMPO" || e.kode === "AUDIT_TRAIL"
        ? "&dariTanggal=2026-01-01&sampaiTanggal=2026-12-31"
        : "";
  if (e.kode === "KARTU_PIUTANG") continue;
  const res = await req(
    `/laporan/ekspor/${e.kode}?periodeId=${tertutup.id}&mode=BULANAN${tambahan}&format=html`,
    auditor,
  );
  if (res.status !== 200) continue;
  diekspor += 1;
  if ((await res.text()).includes("[object Object]")) rusak.push(String(e.nomor));
}
periksa(
  "20b berkas ekspor tidak memuat sel [object Object]",
  rusak.length === 0,
  `${rusak.length} dari ${diekspor} laporan memuatnya${rusak.length > 0 ? ` (laporan ${rusak.join(", ")})` : ""}`,
);

// --- 22 ---------------------------------------------------------------------
const berjalan = periode.data.find((p) => p.status === "OPEN") ?? tertutup;
const dash = await ambil<{
  metrik: Array<{ kunci: string; nama: string; jenis: string; nilai: string; rincian: string | null }>;
}>(`/dashboard?periodeId=${berjalan.id}`, adminPusat);
// THE READING TAKEN. A money KPI must FOOT to its drill-down; a count or a
// ratio cannot, because the drill-down of "71 mitra aktif" is 71 rows and the
// drill-down of "67,32% lancar" is the rupiah behind the percentage. So the
// money ones are compared, and every one of them is required to open onto rows
// that are really there.
let cocok = 0;
let diperiksa = 0;
const beda: string[] = [];
for (const m of dash.metrik) {
  if (!m.rincian) continue;
  const r = await ambil<{ total: string; jumlah: number; terpotong: boolean }>(
    `/dashboard/rincian?periodeId=${berjalan.id}&kunci=${m.rincian}`,
    adminPusat,
  );
  // A KPI whose value is zero has nothing to drill into, and an empty list is
  // the right answer rather than a missing one.
  if (r.jumlah === 0 && Number(m.nilai) !== 0) {
    beda.push(`${m.kunci}: nilai ${m.nilai} tapi drill down kosong`);
    diperiksa += 1;
    continue;
  }
  if (m.jenis !== "UANG") continue;
  diperiksa += 1;
  if (r.total === m.nilai) cocok += 1;
  else beda.push(`${m.kunci}: KPI ${m.nilai} vs drill down ${r.total}`);
}
periksa(
  "22 setiap KPI UANG di Dashboard foots ke drill down-nya",
  diperiksa > 0 && cocok === diperiksa,
  `${cocok}/${diperiksa} KPI uang cocok${beda.length > 0 ? `; ${beda.join("; ")}` : ""}`,
);

// eslint-disable-next-line no-console
console.log(gagal === 0 ? "\nSEMUA BACAAN LULUS.\n" : `\n${gagal} BACAAN GAGAL.\n`);
process.exit(gagal === 0 ? 0 : 1);

// Deterministic randomness, money and calendar helpers for the demo world.
//
// DETERMINISTIC ON PURPOSE. A demo database that differs between two runs is a
// demo nobody can write a script against: SEED.md names accounts, ticket
// numbers and amounts, and a walkthrough that says "open MTR-01-0007" has to
// find the same partner every time. So every choice below comes from a seeded
// PRNG (mulberry32), never from Math.random.
//
// THE ONLY THING THAT MOVES BETWEEN RUNS IS THE CALENDAR, and that is
// deliberate too: spec 13 wants the open period to be the CURRENT month, so
// the demo does not look stale a week after it was built. Everything else is
// derived from the fixed seed.

/** mulberry32. Small, fast, and good enough for demo data spread. */
export function acak(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Dadu {
  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number;
  /** Uniform pick from a non-empty list. */
  pilih<T>(daftar: readonly T[]): T;
  /** True with probability `p`. */
  peluang(p: number): boolean;
  /**
   * Weighted pick. `bobot` maps a key to its relative weight; the sum need not
   * be 1. Used for the payment-behaviour mix, which has to be reproducible.
   */
  bobot<T extends string>(bobot: Readonly<Record<T, number>>): T;
}

export function dadu(seed: number): Dadu {
  const r = acak(seed);
  return {
    int: (min, max) => min + Math.floor(r() * (max - min + 1)),
    pilih: (daftar) => daftar[Math.floor(r() * daftar.length)]!,
    peluang: (p) => r() < p,
    bobot: (bobot) => {
      const entri = Object.entries(bobot) as Array<[string, number]>;
      const total = entri.reduce((s, [, w]) => s + w, 0);
      let x = r() * total;
      for (const [k, w] of entri) {
        x -= w;
        if (x <= 0) return k as never;
      }
      return entri[entri.length - 1]![0] as never;
    },
  };
}

// ---------------------------------------------------------------------------
// Money. Cents as bigint, never float (spec invariant 7).
// ---------------------------------------------------------------------------

export type Uang = string;

/** Whole rupiah to the NUMERIC(20,2) text the engines take. */
export function rp(rupiah: number): Uang {
  return `${BigInt(Math.round(rupiah))}.00`;
}

export function keSen(nilai: Uang): bigint {
  const negatif = nilai.startsWith("-");
  const [utuh = "0", pecahan = "00"] = (negatif ? nilai.slice(1) : nilai).split(".");
  const sen = BigInt(utuh) * 100n + BigInt(pecahan.padEnd(2, "0").slice(0, 2));
  return negatif ? -sen : sen;
}

export function sen(minor: bigint): Uang {
  const negatif = minor < 0n;
  const abs = negatif ? -minor : minor;
  return `${negatif ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

export function tambahUang(...nilai: Uang[]): Uang {
  return sen(nilai.reduce((s, n) => s + keSen(n), 0n));
}

export function kurangUang(a: Uang, b: Uang): Uang {
  return sen(keSen(a) - keSen(b));
}

export function uangNol(a: Uang): boolean {
  return keSen(a) === 0n;
}

/** Rupiah, grouped, for log lines. Not a report format. */
export function rupiahTampil(nilai: Uang): string {
  const negatif = keSen(nilai) < 0n;
  const abs = negatif ? nilai.slice(1) : nilai;
  const [utuh = "0"] = abs.split(".");
  return `${negatif ? "-" : ""}Rp ${utuh.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

/**
 * A plausible loan principal: a round number an officer would actually type.
 * Never 12_345_678, which is what makes seeded money read as test data.
 */
export function pokokWajar(d: Dadu): number {
  const juta = d.pilih([
    10, 12, 15, 15, 20, 20, 25, 25, 25, 30, 30, 35, 40, 40, 50, 50, 60, 75, 75, 90, 100, 120, 150,
  ]);
  // Half the time add a half-million tail, which is what a survey
  // recommendation rounded to the nearest 500 thousand looks like.
  return juta * 1_000_000 + (d.peluang(0.35) ? 500_000 : 0);
}

/** A plausible Non PUMK grant: bigger, rounder, programme sized. */
export function hibahWajar(d: Dadu): number {
  const juta = d.pilih([15, 20, 25, 30, 35, 40, 50, 60, 75, 80, 100, 125, 150, 200, 250, 300]);
  return juta * 1_000_000;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export interface Bulan {
  tahun: number;
  bulan: number;
}

export function isoTanggal(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** UTC noon, so a date never slides a day under a timezone conversion. */
export function tanggal(tahun: number, bulan: number, hari: number): string {
  const akhir = hariTerakhir(tahun, bulan);
  const h = Math.min(Math.max(hari, 1), akhir);
  return `${tahun.toString().padStart(4, "0")}-${bulan.toString().padStart(2, "0")}-${h
    .toString()
    .padStart(2, "0")}`;
}

export function hariTerakhir(tahun: number, bulan: number): number {
  return new Date(Date.UTC(tahun, bulan, 0)).getUTCDate();
}

export function bulanTambah(b: Bulan, delta: number): Bulan {
  const total = b.tahun * 12 + (b.bulan - 1) + delta;
  return { tahun: Math.floor(total / 12), bulan: (total % 12) + 1 };
}

export function bulanSelisih(a: Bulan, b: Bulan): number {
  return b.tahun * 12 + b.bulan - (a.tahun * 12 + a.bulan);
}

export function bulanDariIso(iso: string): Bulan {
  const [t = "0", b = "1"] = iso.split("-");
  return { tahun: Number.parseInt(t, 10), bulan: Number.parseInt(b, 10) };
}

export function tanggalTambahHari(iso: string, hari: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + hari);
  return isoTanggal(d);
}

/** Midday UTC of an ISO date, which is what the movable clock is set to. */
export function saatDari(iso: string): Date {
  return new Date(`${iso}T05:00:00.000Z`);
}

// ---------------------------------------------------------------------------
// Names. Indonesian, varied, and stable across runs.
// ---------------------------------------------------------------------------

export const DEPAN_L = [
  "Agus", "Bambang", "Dedi", "Eko", "Firman", "Gunawan", "Hendra", "Iwan", "Joko", "Kurnia",
  "Lukman", "Mulyadi", "Nurdin", "Oman", "Pramono", "Rizal", "Slamet", "Taufik", "Usman", "Wahyu",
  "Yusuf", "Zainal", "Ahmad", "Budi", "Cahyo", "Deni", "Erwin", "Fajar", "Galih", "Hasan",
];

export const DEPAN_P = [
  "Ani", "Bunga", "Citra", "Dewi", "Eka", "Fitri", "Gita", "Hesti", "Indah", "Juwita",
  "Kartika", "Lestari", "Maryam", "Nurhayati", "Oktaviani", "Puspita", "Ratna", "Siti", "Tuti",
  "Umi", "Vina", "Wulan", "Yanti", "Zahra", "Ayu", "Diah", "Endang", "Farida", "Hani", "Ika",
];

export const BELAKANG = [
  "Saputra", "Wijaya", "Nugroho", "Hidayat", "Ramadhan", "Setiawan", "Kusuma", "Permana",
  "Maulana", "Prasetyo", "Santoso", "Firdaus", "Sulaiman", "Halim", "Rahman", "Anggraini",
  "Puspitasari", "Wahyuni", "Handayani", "Rahayu", "Safitri", "Mardiana", "Suryani", "Kholifah",
];

export const JENIS_USAHA: ReadonlyArray<{ sektor: string; nama: readonly string[] }> = [
  { sektor: "IND", nama: ["Konveksi", "Kerajinan Rotan", "Bengkel Las", "Pengolahan Kerupuk", "Tahu Tempe", "Meubel Kayu"] },
  { sektor: "DAG", nama: ["Warung Sembako", "Toko Kelontong", "Agen Gas dan Air", "Toko Bangunan", "Grosir Snack"] },
  { sektor: "TAN", nama: ["Tani Padi", "Kebun Sayur", "Hidroponik", "Jamur Tiram"] },
  { sektor: "NAK", nama: ["Ternak Ayam Petelur", "Ternak Kambing", "Peternakan Bebek", "Penggemukan Sapi"] },
  { sektor: "BUN", nama: ["Kebun Kelapa", "Kebun Melinjo", "Kebun Pisang"] },
  { sektor: "KAN", nama: ["Budidaya Lele", "Nelayan Jaring", "Tambak Bandeng", "Pengolahan Ikan Asin"] },
  { sektor: "JAS", nama: ["Laundry", "Salon", "Bengkel Motor", "Jasa Fotokopi", "Katering Rumahan", "Jasa Angkut"] },
  { sektor: "LNY", nama: ["Usaha Serba Ada", "Rental Peralatan"] },
];

export const KELURAHAN = [
  "Ciwaduk", "Kebondalem", "Ramanuju", "Masigit", "Jombang Wetan", "Gerem", "Tegal Bunder",
  "Kaligandu", "Cipare", "Lopang", "Unyur", "Sumurpecung", "Banjar Agung", "Kramatwatu",
  "Bojonegara", "Anyer", "Cinangka", "Mancak",
];

export const KECAMATAN = [
  "Cilegon", "Jombang", "Purwakarta", "Grogol", "Citangkil", "Serang", "Cipocok Jaya",
  "Taktakan", "Kramatwatu", "Bojonegara", "Anyer", "Cinangka", "Mancak", "Waringinkurung",
];

export const PROGRAM_NON_PUMK: Readonly<Record<string, readonly string[]>> = {
  PDD: [
    "Beasiswa Anak Karyawan Mitra Binaan",
    "Renovasi Ruang Kelas SD Negeri",
    "Pelatihan Guru Sains Sekolah Dasar",
    "Bantuan Perpustakaan Keliling",
  ],
  KES: [
    "Posyandu Sehat dan Pemberian Makanan Tambahan",
    "Pengadaan Ambulans Desa",
    "Operasi Katarak Gratis",
    "Pemeriksaan Stunting Balita",
  ],
  IBD: [
    "Rehabilitasi Masjid Jami",
    "Pembangunan Mushola Lingkungan Industri",
    "Bantuan Sarana Ibadah Rumah Ibadah Lintas Agama",
  ],
  UMM: [
    "Perbaikan Jalan Lingkungan RW",
    "Pengadaan Air Bersih Perpipaan Desa",
    "Penerangan Jalan Umum Tenaga Surya",
    "Pembangunan Drainase Kampung",
  ],
  BNC: [
    "Tanggap Darurat Banjir Bandang",
    "Bantuan Logistik Korban Angin Puting Beliung",
    "Hunian Sementara Pasca Kebakaran",
  ],
  ALM: [
    "Penanaman Mangrove Pesisir",
    "Bank Sampah Berbasis Warga",
    "Konservasi Mata Air Kampung",
  ],
  KMS: [
    "Bedah Rumah Tidak Layak Huni",
    "Padat Karya Produktif Warga Prasejahtera",
    "Pelatihan Wirausaha Ibu Rumah Tangga",
  ],
};

/** A 16 digit NIK-shaped identifier. Deterministic, and obviously synthetic. */
export function nikDemo(urut: number): string {
  return `3672${(urut % 100).toString().padStart(2, "0")}0101${(1980 + (urut % 25))
    .toString()
    .slice(2)}${(urut % 9000 + 1000).toString()}`;
}

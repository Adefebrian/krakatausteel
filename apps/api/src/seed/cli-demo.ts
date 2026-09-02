#!/usr/bin/env bun
// Entry point for the spec 13 transaction generator.
//
//   bun run db:seed:demo        -> TEST_DATABASE_URL (disposable)
//   bun run db:seed:demo:dev    -> DATABASE_URL      (the local demo database)
//
// SEPARATE FROM `db:seed` ON PURPOSE. `seedFase0` runs inside `bun run verify`
// and before large parts of the suite; it has to stay a few seconds long. This
// generator replays twenty four months through the real engines and takes
// minutes. Wiring it into `db:seed` would put that cost on every test run and
// every gate, for data no unit test asks for.
//
// The same production guard `seedDemo` uses applies: the target database name
// must end in `_dev`, `_test`, `_local` or `_demo`. The credentials this world
// hangs off are public (SEED.md prints them), so a production URL must not be
// able to reach it whatever flags an operator passes.
import { databaseBolehDemo } from "./demo";
import { seedDemoTransaksi } from "./demo-dunia/index";

function pilihTarget(argumen: readonly string[]): { url: string; label: string } {
  const keDev = argumen.includes("--dev");
  const url = keDev ? process.env.DATABASE_URL : process.env.TEST_DATABASE_URL;
  const label = keDev ? "dev DB (DATABASE_URL)" : "test DB (TEST_DATABASE_URL)";
  if (!url) {
    throw new Error(
      `${keDev ? "DATABASE_URL" : "TEST_DATABASE_URL"} belum diset. Salin .env.example ke .env.`,
    );
  }
  if (!databaseBolehDemo(url)) {
    throw new Error(
      `Menolak menulis dunia demo ke database ini: namanya tidak berakhiran _dev, _test, ` +
        "_local atau _demo. Kredensial demo bersifat publik, jadi ini bukan flag yang bisa dilewati.",
    );
  }
  return { url, label };
}

async function main(): Promise<void> {
  const { url, label } = pilihTarget(process.argv.slice(2));
  // The db adapter reads DATABASE_URL; point it at the chosen target for this
  // process only, exactly as tools/db.ts does for `seed` and `seed:dev`.
  process.env.DATABASE_URL = url;

  const redacted = url.replace(/\/\/([^:/@]+):[^@]*@/, "//$1:***@");
  console.log(`seed dunia demo (Bagian 13) pada ${label} (${redacted})`);
  console.log("");

  // Escape hatch for a smoke run: SEED_DEMO_BULAN=4 replays four months
  // instead of twenty four. NOT for a demo database, and it says so, because a
  // short window has no arrears ageing and no year-to-date comparison.
  const bulanEnv = process.env.SEED_DEMO_BULAN;
  const bulanRiwayat = bulanEnv ? Number.parseInt(bulanEnv, 10) : undefined;
  if (bulanRiwayat !== undefined && (!Number.isInteger(bulanRiwayat) || bulanRiwayat < 2)) {
    throw new Error(`SEED_DEMO_BULAN harus bilangan bulat >= 2, bukan "${bulanEnv}"`);
  }
  if (bulanRiwayat !== undefined) {
    console.log(`  CATATAN: SEED_DEMO_BULAN=${bulanRiwayat}, riwayat dipendekkan (uji asap, bukan demo).`);
  }

  const hasil = await seedDemoTransaksi(bulanRiwayat === undefined ? {} : { bulanRiwayat });
  console.log("");
  if (hasil.dilewati) {
    console.log("selesai: tidak ada yang diubah.");
    return;
  }
  console.log(
    `selesai dalam ${hasil.detikBerjalan.toFixed(1)} detik: ` +
      `${hasil.mitra} mitra, ${hasil.proposal} proposal PUMK, ${hasil.akad} akad, ` +
      `${hasil.setoran} setoran, ${hasil.nonPumk} proposal Non PUMK, ` +
      `${hasil.submission} pengajuan portal, ${hasil.periodeDitutup} periode ditutup.`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("");
    console.error(err instanceof Error ? err.message : String(err));
    // The domain errors carry a `kode` and a `detail` object, and losing them
    // turns a precise refusal ("TRANSISI_TIDAK_VALID from DISALURKAN") into
    // prose an operator cannot act on.
    const detail = (err as { kode?: unknown; detail?: unknown } | null)?.detail;
    const kode = (err as { kode?: unknown } | null)?.kode;
    if (kode !== undefined) console.error(`  kode: ${String(kode)}`);
    if (detail !== undefined) console.error(`  detail: ${JSON.stringify(detail)}`);
    const penyebab = (err as { penyebabDb?: unknown } | null)?.penyebabDb;
    if (penyebab !== undefined) console.error(`  penyebab: ${String(penyebab)}`);
    if (process.env.SEED_DEMO_STACK === "1" && err instanceof Error) console.error(err.stack);
    process.exitCode = 1;
  });
}

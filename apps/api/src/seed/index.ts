// Fase 0 seed entry point, called by `bun tools/db.ts seed`.
//
// Split by lifetime:
//   seedRbac                 application fact (permissions + roles). Always.
//   seedKonfigurasiTambahan  config defaults with no migration. Always.
//   seedCoaDanEventMapping   the spec 6.4 event mappings and the accounts they
//                            name. Always, PER BUMN: without these rows
//                            `postingEvent` rejects every business event
//                            (EVENT_MAPPING_TIDAK_DITEMUKAN), so nothing can
//                            be disbursed, repaid or written off at all. See
//                            ./event-jurnal.ts.
//   seedMasterProgram        spec 4.1 sektor PUMK, bidang Non PUMK and the 17
//                            SDG. Always, and NOT demo data: a PUMK proposal
//                            carries a sektor_id and a Non PUMK proposal is
//                            REQUIRED to name a bidang and at least one SDG
//                            (spec 9.2), so an empty master makes those forms
//                            unsubmittable. This was missing, which is why the
//                            Daftar Proposal screen showed "Belum diisi" in
//                            the Sektor column of every row.
//   seedDemo                 DEMO ACCOUNTS. Never on a production database.
//
// Later phases add their own module here (spec 13 asks for 24 months of demo
// transactions in Fase 9) without touching tools/db.ts again.
import { createDbAdapter } from "../core/adapters/db";
import type { DbPort } from "../core/ports/db";
import { seedRbac } from "./rbac";
import { seedKonfigurasiTambahan } from "./konfigurasi";
import { DEMO_PASSWORD, DEMO_USERS, seedDemo } from "./demo";
import { seedCoaDanEventMapping } from "./event-jurnal";
import { seedMasterProgram } from "./master-program";

export { seedRbac, permissionsForRole } from "./rbac";
export { seedKonfigurasiTambahan } from "./konfigurasi";
export {
  AKUN_INTI,
  BARIS_LAPORAN_INTI,
  HEADER_AKUN_INTI,
  seedCoaInti,
  type AkunDef,
  type AkunIdByKode,
} from "./coa-inti";
export {
  KATALOG_EVENT_JURNAL,
  seedCoaDanEventMapping,
  seedEventJurnalMapping,
  type EventJurnalDef,
} from "./event-jurnal";
export {
  BIDANG_NON_PUMK,
  SDG,
  SEKTOR_PUMK,
  seedMasterProgram,
  seedSdg,
  type ReferensiDef,
  type SeedMasterProgramResult,
} from "./master-program";
export {
  databaseBolehDemo,
  seedDemo,
  DEMO_PASSWORD,
  DEMO_USERS,
  DEMO_CABANG,
  DEMO_MITRA,
  DEMO_BUMN_KODE,
} from "./demo";

export interface SeedOptions {
  db?: DbPort;
  /** Set false to seed only RBAC and config, no demo accounts. */
  includeDemo?: boolean;
  log?: (line: string) => void;
  /**
   * Connection string of the target. Passed to `seedDemo`, which refuses to
   * write public demo credentials to a database whose name does not mark it as
   * disposable. Defaults to DATABASE_URL, which is what tools/db.ts points at
   * the chosen target before calling this.
   */
  targetUrl?: string;
}

/**
 * Every bumn already in the database. The event mapping is per bumn (the
 * unique index is `(bumn_id, event_code)`), so seeding "the mappings" means
 * seeding them for each reporting entity that exists, not once globally.
 */
async function bumnIds(db: DbPort): Promise<{ id: string; kode: string }[]> {
  return db.query<{ id: string; kode: string }>(
    "SELECT id::text AS id, kode FROM bumn WHERE deleted_at IS NULL ORDER BY kode",
  );
}

/**
 * COA + event mapping + programme master for every bumn present. Idempotent,
 * safe to repeat.
 */
async function seedLedgerReferensi(db: DbPort, log: (line: string) => void): Promise<void> {
  const entitas = await bumnIds(db);
  if (entitas.length === 0) {
    log("  ledger      belum ada bumn; COA inti, event mapping dan master program dilewati");
    return;
  }
  for (const bumn of entitas) {
    // One transaction per bumn: a half-seeded mapping table is worse than none,
    // because `postingEvent` would work for some events and not others.
    const hasil = await db.transaction((tx) => seedCoaDanEventMapping(tx, bumn.id));
    log(
      `  ledger      ${bumn.kode}: ${hasil.akun.size} akun inti, ` +
        `${hasil.event.seeded} dari ${hasil.event.total} event mapping baru`,
    );
    // Separate transaction from the ledger's: reference data failing must not
    // roll back a correct COA, and neither half depends on the other.
    const master = await db.transaction((tx) => seedMasterProgram(tx, bumn.id));
    log(
      `  master      ${bumn.kode}: ${master.sektor} sektor PUMK, ` +
        `${master.bidang} bidang Non PUMK, ${master.sdg} SDG baru`,
    );
  }
}

export async function seedFase0(options: SeedOptions = {}): Promise<void> {
  const db = options.db ?? createDbAdapter();
  const log = options.log ?? ((line: string) => console.log(line));

  const rbac = await seedRbac(db);
  log(`  rbac        ${rbac.permissions} permission, ${rbac.roles} role, ${rbac.grants} grant`);

  const config = await seedKonfigurasiTambahan(db);
  log(`  konfigurasi ${config.inserted} baru dari ${config.total} kunci kapabilitas (sisanya sudah ada)`);

  if (options.includeDemo === false) {
    log("  demo        dilewati (includeDemo: false)");
    // Still seeded, and this is the important half: a production install with
    // no demo data must have a postable COA and all 19 event mappings, or
    // every business event is rejected.
    await seedLedgerReferensi(db, log);
    return;
  }

  const demo = await seedDemo(db, {
    targetUrl: options.targetUrl ?? process.env.DATABASE_URL ?? "",
  });
  log(`  demo        ${Object.keys(demo.users).length} user, ${Object.keys(demo.cabang).length} cabang, 1 mitra portal`);
  // After seedDemo, so the entity it just created is included in the same pass.
  await seedLedgerReferensi(db, log);
  log("");
  log("  KREDENSIAL DEMO (DEMO ONLY, jangan pernah dipakai di produksi)");
  log(`  password semua akun: ${DEMO_PASSWORD}`);
  for (const user of DEMO_USERS) {
    log(`    ${user.username.padEnd(14)} ${user.role.padEnd(13)} cabang ${user.cabangKode}`);
  }
  log(`    portal mitra   ${demo.portalAkunId ? "mitra@demo.tjsl.local" : "-"} (login portal, Fase 7)`);
}

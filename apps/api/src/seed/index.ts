// Fase 0 seed entry point, called by `bun tools/db.ts seed`.
//
// Split in three because they have different lifetimes:
//   seedRbac                 application fact (permissions + roles). Always.
//   seedKonfigurasiTambahan  config defaults with no migration. Always.
//   seedDemo                 DEMO ACCOUNTS. Never on a production database.
//
// Later phases add their own module here (spec 13 asks for 24 months of demo
// transactions in Fase 9) without touching tools/db.ts again.
import { createDbAdapter } from "../core/adapters/db";
import type { DbPort } from "../core/ports/db";
import { seedRbac } from "./rbac";
import { seedKonfigurasiTambahan } from "./konfigurasi";
import { DEMO_PASSWORD, DEMO_USERS, seedDemo } from "./demo";

export { seedRbac } from "./rbac";
export { seedKonfigurasiTambahan } from "./konfigurasi";
export {
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
    return;
  }

  const demo = await seedDemo(db);
  log(`  demo        ${Object.keys(demo.users).length} user, ${Object.keys(demo.cabang).length} cabang, 1 mitra portal`);
  log("");
  log("  KREDENSIAL DEMO (DEMO ONLY, jangan pernah dipakai di produksi)");
  log(`  password semua akun: ${DEMO_PASSWORD}`);
  for (const user of DEMO_USERS) {
    log(`    ${user.username.padEnd(14)} ${user.role.padEnd(13)} cabang ${user.cabangKode}`);
  }
  log(`    portal mitra   ${demo.portalAkunId ? "mitra@demo.tjsl.local" : "-"} (login portal, Fase 7)`);
}

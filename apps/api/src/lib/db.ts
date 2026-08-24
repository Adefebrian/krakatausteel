// Postgres pool, lazily constructed. `new Pool(...)` never opens a socket by
// itself, only `.connect()` / a query does, so importing this module (or
// importing something that imports it) is always safe with no Postgres
// running, e.g. under `bun test`.
import { Pool } from "pg";

let pool: Pool | undefined;

export function getDb(): Pool {
  if (!pool) {
    // NO FALLBACK CONNECTION STRING. There used to be a default of
    // postgres://user:password@localhost:5432/app here, which is the worst kind
    // of default: on a developer's machine it can actually connect to
    // SOMETHING, so a missing DATABASE_URL shows up as mysterious empty tables
    // or a write to the wrong database instead of as a configuration error. On
    // a server it produces a connection-refused storm with no hint of the
    // cause. An accounting system must never guess where its ledger lives.
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL tidak diset. Salin .env.example ke .env untuk lokal, atau set env " +
          "tersebut di deployment. Tidak ada nilai default: menebak database untuk sistem " +
          "akuntansi bukan pilihan.",
      );
    }
    pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

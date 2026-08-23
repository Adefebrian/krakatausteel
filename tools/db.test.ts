// Unit tests for the test-database safety rails in tools/db.ts, plus a live
// assertion that the tools/test-env.ts preload actually took effect. The
// second one matters more than it looks: it is the thing standing between a
// test suite and the development ledger.
import { describe, expect, test } from "bun:test";
import { databaseNameOf, isTestDatabase, redact } from "./db";

describe("databaseNameOf", () => {
  test("reads the database name from a bare host URL", () => {
    expect(databaseNameOf("postgres://localhost:5432/tjsl_test")).toBe("tjsl_test");
  });

  test("reads it from a URL with credentials", () => {
    expect(databaseNameOf("postgres://u:p@db.internal:5432/tjsl_dev")).toBe("tjsl_dev");
  });

  test("ignores a query string", () => {
    expect(databaseNameOf("postgres://localhost/tjsl_test?sslmode=require")).toBe("tjsl_test");
  });

  test("throws rather than guess when there is no database segment", () => {
    expect(() => databaseNameOf("postgres://localhost:5432")).toThrow();
  });
});

describe("isTestDatabase", () => {
  test("accepts only names ending in _test", () => {
    expect(isTestDatabase("postgres://localhost/tjsl_test")).toBe(true);
    expect(isTestDatabase("postgres://localhost/tjsl_dev")).toBe(false);
    expect(isTestDatabase("postgres://localhost/test")).toBe(false);
    expect(isTestDatabase("postgres://localhost/tjsl_testing")).toBe(false);
  });
});

describe("redact", () => {
  test("hides the password and keeps the rest readable", () => {
    expect(redact("postgres://u:s3cr3t@host:5432/db")).toBe("postgres://u:***@host:5432/db");
  });

  test("leaves a passwordless URL alone", () => {
    expect(redact("postgres://localhost:5432/db")).toBe("postgres://localhost:5432/db");
  });
});

describe("tools/test-env.ts preload", () => {
  test("DATABASE_URL points at the test database, never the dev one", () => {
    const url = process.env.DATABASE_URL;
    if (!process.env.TEST_DATABASE_URL) {
      // No test DB configured: the preload must have unset DATABASE_URL
      // rather than leave the dev database reachable.
      expect(url).toBeUndefined();
      return;
    }
    expect(url).toBe(process.env.TEST_DATABASE_URL);
    expect(isTestDatabase(url!)).toBe(true);
  });
});

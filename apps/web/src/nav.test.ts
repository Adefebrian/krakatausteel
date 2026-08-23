import { describe, expect, test } from "bun:test";
import { ALL_ROUTES, NAV_GROUPS, canOpen, findRoute, visibleNav } from "./nav";
import { PERMISSIONS_BY_ROLE } from "./permissions";
import { REPORTS, REPORT_GROUPS } from "./reports";

// The banned long dash, written as an escape so this file itself stays clean.
const LONG_DASH = "\u2014";

function groupIds(permissions: readonly string[]): string[] {
  return visibleNav(permissions).map((group) => group.id);
}

function labels(permissions: readonly string[], groupId: string): string[] {
  const group = visibleNav(permissions).find((candidate) => candidate.id === groupId);
  return group ? group.items.map((item) => item.label) : [];
}

describe("navigation grouping", () => {
  test("groups follow spec section 9, in spec order", () => {
    expect(NAV_GROUPS.map((group) => group.label)).toEqual([
      "Dashboard",
      "Pendanaan UMK",
      "Non PUMK",
      "Jurnal",
      "Laporan",
      "Admin",
      "Konfigurasi",
      "Portal",
      "Tools",
    ]);
  });

  test("every route has a unique path", () => {
    const paths = ALL_ROUTES.map((route) => route.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("all 31 catalog reports have a page, none of them in the nav list", () => {
    for (const report of REPORTS) {
      const route = findRoute(`/laporan/${report.slug}`);
      expect(route).toBeTruthy();
      expect(route?.hideFromNav).toBe(true);
    }
    const laporan = visibleNav(PERMISSIONS_BY_ROLE.ADMIN_PUSAT).find(
      (group) => group.id === "laporan",
    );
    // Only the four catalog pages are listed, the 31 reports open from them.
    expect(laporan?.items).toHaveLength(REPORT_GROUPS.length);
  });
});

describe("visibleNav hides what the permission set lacks", () => {
  test("an empty permission set produces no navigation at all", () => {
    expect(visibleNav([])).toEqual([]);
  });

  test("Maker has no Admin and no Konfigurasi group", () => {
    const ids = groupIds(PERMISSIONS_BY_ROLE.MAKER);
    expect(ids).toContain("pumk");
    expect(ids).toContain("jurnal");
    expect(ids).not.toContain("admin");
    expect(ids).not.toContain("konfigurasi");
  });

  test("Maker sees input pages, Checker does not", () => {
    expect(labels(PERMISSIONS_BY_ROLE.MAKER, "pumk")).toContain("Input Proposal");
    expect(labels(PERMISSIONS_BY_ROLE.CHECKER, "pumk")).not.toContain("Input Proposal");
    expect(labels(PERMISSIONS_BY_ROLE.CHECKER, "pumk")).toContain("Review Checker");
  });

  test("only the Approver side sees posting and persetujuan", () => {
    expect(labels(PERMISSIONS_BY_ROLE.APPROVER, "jurnal")).toContain("Posting Jurnal");
    expect(labels(PERMISSIONS_BY_ROLE.MAKER, "jurnal")).not.toContain("Posting Jurnal");
    expect(labels(PERMISSIONS_BY_ROLE.APPROVER, "pumk")).toContain("Persetujuan Proposal");
    expect(labels(PERMISSIONS_BY_ROLE.CHECKER, "pumk")).not.toContain("Persetujuan Proposal");
  });

  test("Auditor is read only: reports yes, every input page no", () => {
    const ids = groupIds(PERMISSIONS_BY_ROLE.AUDITOR);
    expect(ids).toContain("laporan");
    expect(ids).not.toContain("admin");
    expect(ids).not.toContain("tools");
    expect(labels(PERMISSIONS_BY_ROLE.AUDITOR, "pumk")).not.toContain("Input Proposal");
    expect(labels(PERMISSIONS_BY_ROLE.AUDITOR, "pumk")).not.toContain("Pencairan");
    expect(labels(PERMISSIONS_BY_ROLE.AUDITOR, "jurnal")).toEqual(["Daftar Jurnal"]);
  });

  test("Admin Pusat sees every group", () => {
    expect(groupIds(PERMISSIONS_BY_ROLE.ADMIN_PUSAT)).toEqual(NAV_GROUPS.map((group) => group.id));
  });

  test("a group with no permitted item disappears instead of showing an empty heading", () => {
    expect(groupIds(["dashboard.view"])).toEqual(["dashboard"]);
  });
});

describe("canOpen", () => {
  test("mirrors the nav filter for a direct URL hit", () => {
    expect(canOpen(PERMISSIONS_BY_ROLE.MAKER, "/pumk/proposal/baru")).toBe(true);
    expect(canOpen(PERMISSIONS_BY_ROLE.AUDITOR, "/pumk/proposal/baru")).toBe(false);
    expect(canOpen(PERMISSIONS_BY_ROLE.ADMIN_PUSAT, "/tidak-ada")).toBe(false);
  });

  test("a hidden report page is still openable with laporan.view", () => {
    expect(canOpen(PERMISSIONS_BY_ROLE.AUDITOR, "/laporan/neraca-lajur")).toBe(true);
    expect(canOpen(["dashboard.view"], "/laporan/neraca-lajur")).toBe(false);
  });
});

describe("copy hygiene", () => {
  test("no long dash anywhere in the page inventory", () => {
    for (const route of ALL_ROUTES) {
      const text = [route.label, route.title, route.summary, ...route.willContain].join(" ");
      expect(text).not.toContain(LONG_DASH);
    }
  });

  test("every route states what will live in it", () => {
    for (const route of ALL_ROUTES) {
      if (route.path === "/") continue;
      expect(route.summary.length).toBeGreaterThan(0);
      expect(route.willContain.length).toBeGreaterThan(0);
    }
  });
});

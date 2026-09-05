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
  test("groups follow spec section 9, in spec order, with the optional layer last", () => {
    // The first nine are spec section 9's own order and nothing may reorder
    // them. "Asisten" is spec 12's optional layer (Fase 8) and it is LAST on
    // purpose: it is switched off by default, so it sits after every group the
    // product is whole without.
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
      "Asisten",
    ]);
  });

  test("the assistant's two pages are held by different people, mirroring the server", () => {
    // Filling a form faster and deciding which entries to read first are
    // different jobs. A Maker who could open the review queue, or a Checker who
    // could open the document assistant, would be a menu asserting a product
    // the server refuses.
    expect(labels(PERMISSIONS_BY_ROLE.MAKER, "asisten")).toEqual(["Asisten Dokumen"]);
    expect(labels(PERMISSIONS_BY_ROLE.CHECKER, "asisten")).toEqual(["Antrean Anomali"]);
    expect(labels(PERMISSIONS_BY_ROLE.APPROVER, "asisten")).toEqual(["Antrean Anomali"]);
    // Read only, and the queue is one more read over journals it may open.
    expect(labels(PERMISSIONS_BY_ROLE.AUDITOR, "asisten")).toEqual(["Antrean Anomali"]);
    expect(labels(PERMISSIONS_BY_ROLE.ADMIN_PUSAT, "asisten")).toEqual([
      "Asisten Dokumen",
      "Antrean Anomali",
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
    // The Tools group IS visible, and holds exactly the two DIAGNOSTIC pages.
    // Decided 2026-09-02: both are GET only and the module is composed with no
    // journal port and no audit port, so granting them withholds nothing, and
    // refusing the read only role the one reconciliation an external auditor
    // asks for first was the contradiction. What the Auditor must still NOT
    // see is the import pages, which are the writing half of spec 9.6 and stay
    // with the Maker. Asserted as the exact list, so a third read only tool
    // added later is a deliberate change rather than a silent one.
    expect(ids).toContain("tools");
    expect(labels(PERMISSIONS_BY_ROLE.AUDITOR, "tools")).toEqual([
      "Rekonsiliasi Piutang",
      "Cek Integritas",
    ]);
    expect(labels(PERMISSIONS_BY_ROLE.AUDITOR, "pumk")).not.toContain("Input Proposal");
    expect(labels(PERMISSIONS_BY_ROLE.AUDITOR, "pumk")).not.toContain("Pencairan");
    expect(labels(PERMISSIONS_BY_ROLE.AUDITOR, "jurnal")).toEqual(["Daftar Jurnal"]);
    // The Admin group IS visible to an Auditor, and holds exactly the three
    // closing evidence screens and nothing else. See the closing block below:
    // that is `admin.closing.view` doing its job, not a leak.
    expect(ids).toContain("admin");
    expect(labels(PERMISSIONS_BY_ROLE.AUDITOR, "admin")).not.toContain("RKA Pendanaan UMK");
  });

  test("Admin Pusat sees every group", () => {
    expect(groupIds(PERMISSIONS_BY_ROLE.ADMIN_PUSAT)).toEqual(NAV_GROUPS.map((group) => group.id));
  });

  test("a group with no permitted item disappears instead of showing an empty heading", () => {
    expect(groupIds(["dashboard.view"])).toEqual(["dashboard"]);
  });
});

// ---------------------------------------------------------------------------
// The closing screens, spec 8 and spec 9.3
// ---------------------------------------------------------------------------
//
// The theme of this block is that the READ side of the monthly close and its
// WRITE side are two different authorities, and that the nav reflects the
// server's own split rather than a second opinion about it. Gating the pages on
// `admin.closing.periode` would have meant either handing a write code to a
// role that must never write, or locking the Auditor out of the evidence that
// spec 16 scenario 23 makes their primary object.

const HALAMAN_CLOSING = ["Closing Kolektibilitas", "Closing Periode", "Periode Akuntansi"];

describe("closing screens are gated on the read code, not on the run codes", () => {
  test("all three closing pages carry admin.closing.view", () => {
    for (const path of [
      "/admin/closing-kolektibilitas",
      "/admin/closing-periode",
      "/admin/periode",
    ]) {
      expect(findRoute(path)?.permission).toBe("admin.closing.view");
    }
  });

  test("an Auditor holding only the evidence codes reaches every closing screen", () => {
    expect(labels(PERMISSIONS_BY_ROLE.AUDITOR, "admin")).toEqual(HALAMAN_CLOSING);
    for (const path of [
      "/admin/closing-kolektibilitas",
      "/admin/closing-periode",
      "/admin/periode",
    ]) {
      expect(canOpen(PERMISSIONS_BY_ROLE.AUDITOR, path)).toBe(true);
    }
  });

  test("admin.closing.view alone is enough, and no run code is needed to read", () => {
    expect(canOpen(["admin.closing.view"], "/admin/closing-periode")).toBe(true);
    expect(canOpen(["admin.closing.view"], "/admin/closing-kolektibilitas")).toBe(true);
    expect(canOpen(["admin.closing.view"], "/admin/periode")).toBe(true);
  });

  test("a run code without the read code does not open a closing screen", () => {
    // The server registers every closing READ under `admin.closing.view`, so a
    // session holding only a run code would open a page whose every panel is a
    // 403. The nav agrees with the server instead of guessing.
    expect(canOpen(["admin.closing.kolektibilitas"], "/admin/closing-kolektibilitas")).toBe(false);
    expect(canOpen(["admin.closing.periode"], "/admin/closing-periode")).toBe(false);
    expect(canOpen(["admin.periode.reopen"], "/admin/periode")).toBe(false);
  });

  test("the Approver sees all three, because closing is the Approver's act", () => {
    expect(labels(PERMISSIONS_BY_ROLE.APPROVER, "admin")).toEqual(HALAMAN_CLOSING);
  });

  test("a Maker and a Checker see no closing screen at all", () => {
    expect(labels(PERMISSIONS_BY_ROLE.MAKER, "admin")).toEqual([]);
    expect(labels(PERMISSIONS_BY_ROLE.CHECKER, "admin")).toEqual([]);
    expect(canOpen(PERMISSIONS_BY_ROLE.MAKER, "/admin/closing-periode")).toBe(false);
    expect(canOpen(PERMISSIONS_BY_ROLE.CHECKER, "/admin/periode")).toBe(false);
  });

  test("Admin Cabang inherits the closing screens, Admin Pusat has them plus RKA", () => {
    const cabang = labels(PERMISSIONS_BY_ROLE.ADMIN_CABANG, "admin");
    for (const label of HALAMAN_CLOSING) expect(cabang).toContain(label);
    expect(labels(PERMISSIONS_BY_ROLE.ADMIN_PUSAT, "admin")).toContain("RKA Pendanaan UMK");
  });

  test("reopen is Admin Pusat only, and the Approver who may close does not hold it", () => {
    // The nav does not gate on this code, the page does. Asserted here because
    // the mirror in ./permissions.ts is what the page reads, and a drift would
    // light up a control the server refuses.
    expect(PERMISSIONS_BY_ROLE.ADMIN_PUSAT).toContain("admin.periode.reopen");
    expect(PERMISSIONS_BY_ROLE.APPROVER).not.toContain("admin.periode.reopen");
    expect(PERMISSIONS_BY_ROLE.AUDITOR).not.toContain("admin.periode.reopen");
    expect(PERMISSIONS_BY_ROLE.AUDITOR).not.toContain("admin.closing.periode");
    expect(PERMISSIONS_BY_ROLE.AUDITOR).not.toContain("admin.closing.kolektibilitas");
    expect(PERMISSIONS_BY_ROLE.AUDITOR).toContain("admin.closing.view");
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

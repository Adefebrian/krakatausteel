// The route matcher Fase 3 needed: a proposal detail page and a kartu piutang
// are per document, so a path parameter had to exist. The tests below pin the
// two properties that keep it from swallowing paths meant for other pages.
import { describe, expect, test } from "bun:test";
import { ALL_ROUTES, findRoute, matchRoute } from "./nav";
import { PERMISSIONS_BY_ROLE } from "./permissions";
import { canOpen } from "./nav";

describe("matchRoute", () => {
  test("an exact route always wins over a parameterised one", () => {
    // /pumk/proposal/baru is the input form. If the parameter pattern won, it
    // would open as a proposal whose id is the word "baru".
    expect(matchRoute("/pumk/proposal/baru")?.route.path).toBe("/pumk/proposal/baru");
    expect(matchRoute("/pumk/proposal/baru")?.params).toEqual({});
  });

  test("a parameter captures exactly one segment and hands it to the page", () => {
    const hit = matchRoute("/pumk/proposal/9f2c8b21");
    expect(hit?.route.path).toBe("/pumk/proposal/:proposalId");
    expect(hit?.params.proposalId).toBe("9f2c8b21");

    const kartu = matchRoute("/pumk/kartu-piutang/a1");
    expect(kartu?.route.path).toBe("/pumk/kartu-piutang/:akadId");
    expect(kartu?.params.akadId).toBe("a1");
  });

  test("it does not match across a segment boundary, and an empty segment is not an id", () => {
    expect(matchRoute("/pumk/proposal/9f2c/riwayat")).toBeUndefined();
    expect(matchRoute("/pumk/proposal/")?.route.path).toBe("/pumk/proposal");
    expect(matchRoute("/tidak/ada/halaman")).toBeUndefined();
  });

  test("an encoded id arrives decoded, so a page never decodes the URL itself", () => {
    expect(matchRoute("/pumk/kartu-piutang/a%2F1")?.params.akadId).toBe("a/1");
  });

  test("findRoute still answers for an exact path, as the shell relies on", () => {
    expect(findRoute("/pumk/proposal")?.title).toBe("Daftar Proposal Pendanaan UMK");
    expect(findRoute("/pumk/kartu-piutang/a1")?.path).toBe("/pumk/kartu-piutang/:akadId");
  });
});

describe("the detail pages are permission gated like every other page", () => {
  test("a per document page carries the same permission as its list", () => {
    expect(canOpen(PERMISSIONS_BY_ROLE.MAKER, "/pumk/proposal/p1")).toBe(true);
    expect(canOpen(PERMISSIONS_BY_ROLE.AUDITOR, "/pumk/kartu-piutang/a1")).toBe(true);
    expect(canOpen(["dashboard.view"], "/pumk/kartu-piutang/a1")).toBe(false);
  });

  test("every parameterised route is hidden from the navigation", () => {
    for (const route of ALL_ROUTES) {
      if (route.path.includes("/:")) expect(route.hideFromNav).toBe(true);
    }
  });
});

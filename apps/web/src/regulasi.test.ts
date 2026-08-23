import { describe, expect, test } from "bun:test";
import { ALL_ROUTES } from "./nav";
import { REPORTS } from "./reports";
import {
  barisTemplate,
  DASAR_HUKUM,
  REPORT_TEMPLATE_BAGIAN,
  TEMPLATE_DEFAULT,
  TEMPLATE_LAPORAN,
  templateById,
} from "./regulasi";

describe("dasar hukum", () => {
  test("points at the regulation actually in force, not the repealed one", () => {
    // PER-05/MBU/04/2021 was repealed by PER-1/MBU/03/2023 Pasal 41, see
    // docs/REGULASI.md. The number reaches auditors through report headers,
    // so it lives here as a value and nowhere else.
    expect(DASAR_HUKUM.nomor).toBe("PER-1/MBU/03/2023");
    expect(DASAR_HUKUM.status).toBe("BERLAKU");
  });

  test("no page or route restates a regulation number as a literal", () => {
    for (const route of ALL_ROUTES) {
      const text = [route.title, route.summary, ...route.willContain].join(" ");
      expect(text).not.toContain("PER-05/MBU/04/2021");
      expect(text).not.toContain("PER-1/MBU/03/2023");
    }
  });
});

describe("template baris laporan", () => {
  test("two templates coexist, PSAK 45 wording and ISAK 335 wording", () => {
    expect(TEMPLATE_LAPORAN.map((template) => template.id)).toEqual(["PSAK_45", "ISAK_335"]);
    expect(TEMPLATE_DEFAULT).toBe("PSAK_45");
  });

  test("the two templates really do use different wording", () => {
    const psak = templateById("PSAK_45");
    const isak = templateById("ISAK_335");
    expect(psak.barisAsetNeto).not.toEqual(isak.barisAsetNeto);
    expect(psak.barisAsetNeto.join(" ")).toContain("Tidak Terikat");
    expect(isak.barisAsetNeto.join(" ")).toContain("Tanpa Pembatasan");
    for (const template of TEMPLATE_LAPORAN) {
      expect(template.barisAktivitas).toHaveLength(2);
      expect(template.barisAsetNeto).toHaveLength(2);
      expect(template.kategoriPerubahan).toHaveLength(2);
    }
  });

  test("every template driven slug is a real report in the catalog", () => {
    const slugs = new Set(REPORTS.map((report) => report.slug));
    for (const slug of Object.keys(REPORT_TEMPLATE_BAGIAN)) {
      expect(slugs.has(slug)).toBe(true);
    }
  });

  test("barisTemplate resolves per report and stays null elsewhere", () => {
    expect(barisTemplate("laporan-posisi-keuangan", "ISAK_335")?.[0]).toContain(
      "Tanpa Pembatasan",
    );
    expect(barisTemplate("laporan-aktivitas", "PSAK_45")?.[0]).toContain("Tidak Terikat");
    expect(barisTemplate("buku-besar", "PSAK_45")).toBeNull();
  });

  test("report metadata does not hardcode one template's wording", () => {
    // Phase 6 must be able to seed a third template without editing copy.
    for (const report of REPORTS) {
      expect(report.kolomKunci).not.toContain("Aset Neto Tidak Terikat");
      expect(report.pengelompokan).not.toContain("Aset Neto Tidak Terikat");
      expect(report.kolomKunci).not.toContain("Tanpa Pembatasan");
    }
  });
});

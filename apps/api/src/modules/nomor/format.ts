// Document-number formatting. Pure: no database, no clock, no framework, so
// every template rule below is pinned by a unit test.
//
// The template comes from `nomor_urut.format_template` (spec 4.10), i.e. it is
// DATA an operator can change, which means two things this file is strict
// about:
//
//   - an unknown placeholder is an ERROR, not an empty string. A template
//     saved as "{urutann:4}/PUMK" must not silently start producing document
//     numbers with a literal "{urutann:4}" in them, or worse, nothing at all
//     where the sequence should be.
//   - a template that never renders the sequence is an ERROR, because every
//     document would then get the same number and the uniqueness the counter
//     exists to provide would be gone.
//
// Roman numeral months are in the placeholder set because that is how
// Indonesian document numbering is actually written: 0007/PUMK/CLG/VIII/2026.

const PLACEHOLDER_RE = /\{([a-z0-9_]+)(?::(\d+))?\}/g;

/** Roman numerals 1..12, for {bulan_romawi}. */
const ROMAWI = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"] as const;

export interface FormatKonteks {
  urutan: number;
  tahun: number;
  /** null for a yearly series with no monthly reset. */
  bulan: number | null;
  jenisDokumen: string;
  /** Branch code; empty for a pusat-level (entity-wide) series. */
  kodeCabang: string;
  kodeBumn: string;
}

export const DEFAULT_FORMAT_TEMPLATE = "{urutan:4}/{jenis}/{kode_cabang}/{bulan_romawi}/{tahun}";

export function bulanRomawi(bulan: number): string {
  const value = ROMAWI[bulan - 1];
  if (!value) throw new Error(`Bulan ${bulan} di luar rentang 1..12`);
  return value;
}

export function formatNomor(template: string, konteks: FormatKonteks): string {
  if (template.trim().length === 0) {
    throw new Error("format_template kosong");
  }
  let renderedUrutan = false;

  const hasil = template.replace(PLACEHOLDER_RE, (_match, nameRaw: string, padRaw?: string) => {
    const pad = padRaw === undefined ? 0 : Number(padRaw);
    switch (nameRaw) {
      case "urutan":
        renderedUrutan = true;
        return String(konteks.urutan).padStart(pad, "0");
      case "tahun":
        return String(konteks.tahun);
      case "tahun2":
        return String(konteks.tahun % 100).padStart(2, "0");
      case "bulan":
        if (konteks.bulan === null) {
          throw new Error("format_template memakai {bulan} tetapi seri ini tidak punya bulan");
        }
        return String(konteks.bulan).padStart(Math.max(2, pad), "0");
      case "bulan_romawi":
        if (konteks.bulan === null) {
          throw new Error("format_template memakai {bulan_romawi} tetapi seri ini tidak punya bulan");
        }
        return bulanRomawi(konteks.bulan);
      case "jenis":
        return konteks.jenisDokumen;
      case "kode_cabang":
        return konteks.kodeCabang;
      case "kode_bumn":
        return konteks.kodeBumn;
      default:
        throw new Error(
          `format_template memakai placeholder tidak dikenal "{${nameRaw}}". ` +
            "Yang tersedia: {urutan[:n]}, {tahun}, {tahun2}, {bulan[:n]}, {bulan_romawi}, " +
            "{jenis}, {kode_cabang}, {kode_bumn}",
        );
    }
  });

  if (!renderedUrutan) {
    throw new Error(
      `format_template "${template}" tidak memuat {urutan}; setiap dokumen akan mendapat nomor yang sama`,
    );
  }
  // A pusat-level series has no branch code, which leaves "//" in a template
  // written for branches. Collapse it rather than emit a malformed number.
  return hasil.replace(/\/{2,}/g, "/").replace(/^\/|\/$/g, "");
}

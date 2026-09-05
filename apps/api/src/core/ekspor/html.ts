// The printable form of a report: one self-contained HTML document.
//
// IT IS AN OUTPUT IN ITS OWN RIGHT, NOT AN INTERMEDIATE. `format=html` returns
// this straight to the browser with `@media print` already set up, so an
// operator prints a report to PDF with the machine and the fonts in front of
// them and no server-side browser is involved at all. `format=pdf` renders the
// SAME string through core/adapters/pdf-chromium.ts. One layout, so the filed
// PDF and the printed page cannot disagree.
//
// SELF-CONTAINED IS A SECURITY PROPERTY, NOT A CONVENIENCE. There is no
// `<script>`, no `<img>`, no `<link>`, no webfont and no URL of any kind in
// what this produces. The renderer therefore has nothing to fetch, which means
// the headless browser cannot be steered into fetching something: a partner
// address containing `<img src="http://169.254.169.254/...">` is not a request
// this document can make, because that string never becomes markup.
//
// EVERY INTERPOLATED VALUE GOES THROUGH `loloskanHtml`. All five characters,
// including the apostrophe, because values land inside attributes too.
//
// FORMULA NEUTRALISATION APPLIES HERE AS WELL, and that is not paranoia about
// HTML: an HTML table is the single most common thing people copy into Excel,
// and a paste carries the cell text intact. A report that is safe as .xlsx and
// executes when pasted would be a hole in the shape of a workaround.
import { netralkanFormula } from "../xlsx/sanitasi";
import type { DokumenEkspor } from "./dokumen";
import type { Sel } from "../xlsx/tulis";

export function loloskanHtml(teks: string): string {
  return teks
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Indonesian thousands separators, done on the DECIMAL STRING.
 *
 * `1234567.89` -> `1.234.567,89` by splitting the text and grouping the digits
 * as characters. No `Number`, no `toLocaleString`, no division: the same rule
 * as the .xlsx path, for the same reason.
 */
export function formatDesimal(desimal: string): string {
  const negatif = desimal.startsWith("-");
  const tanpaTanda = negatif ? desimal.slice(1) : desimal;
  const [utuh = "0", pecah] = tanpaTanda.split(".");
  const dikelompokkan = utuh.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negatif ? "-" : ""}${dikelompokkan}${pecah === undefined ? "" : `,${pecah}`}`;
}

function selHtml(sel: Sel): { teks: string; kanan: boolean; tebal: boolean } {
  const tebal = sel.tebal === true;
  if (sel.jenis === "kosong") return { teks: "", kanan: false, tebal };
  if (sel.jenis === "teks") return { teks: sel.teks ?? "", kanan: false, tebal };
  if (sel.jenis === "tanggal") return { teks: sel.teks ?? "", kanan: false, tebal };
  const d = sel.desimal ?? "";
  if (!/^-?\d+(\.\d+)?$/.test(d)) return { teks: d, kanan: false, tebal };
  if (sel.jenis === "persen") return { teks: `${formatDesimal(d)}%`, kanan: true, tebal };
  return { teks: formatDesimal(d), kanan: true, tebal };
}

/**
 * White page, black text, one hairline per table rule and nothing else. No
 * accent colour, no banding, no rounded corners, no logo: this is a document
 * that goes into an audit file and gets photocopied, and every decoration on
 * it is one more thing that reproduces badly and says nothing.
 */
const GAYA = `
  @page { size: A4 landscape; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Arial, sans-serif; font-size: 9pt;
         color: #111; background: #fff; margin: 0; }
  h1 { font-size: 13pt; margin: 0 0 2mm; }
  h2 { font-size: 10pt; margin: 6mm 0 2mm; page-break-after: avoid; }
  .kop { margin-bottom: 5mm; }
  .kop .bumn { font-size: 10pt; }
  dl { display: grid; grid-template-columns: 34mm auto 34mm auto; gap: 0.6mm 3mm; margin: 0; }
  dt { color: #555; }
  dd { margin: 0; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 4mm; }
  th, td { border: 0.2mm solid #999; padding: 1mm 1.6mm; text-align: left;
           vertical-align: top; word-break: break-word; }
  th { background: #f2f2f2; font-weight: 600; }
  td.n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  td.b, th.b { font-weight: 700; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  .kosong { color: #555; font-style: italic; }
`;

export interface OpsiHtml {
  /** Rows per table. A 20 000-row report becomes a PDF nobody can open. */
  maksBarisPerTabel?: number;
}

export function htmlDariDokumen(dok: DokumenEkspor, opsi: OpsiHtml = {}): string {
  const maks = opsi.maksBarisPerTabel ?? 20_000;
  const h = dok.header;
  const e = loloskanHtml;

  const fakta: Array<[string, string]> = [
    ["Periode", h.periodeLabel],
    ["Cabang", h.namaCabang],
    ["Status periode", h.statusPeriode ?? "-"],
    ["Sumber data", h.sumberData],
    ["Tanggal cetak", h.tanggalCetak],
    ["Dicetak oleh", h.dicetakOleh],
    ...h.tambahan.map((t): [string, string] => [t.label, t.nilai]),
  ];

  const bagian = dok.tabel.map((t) => {
    if (t.baris.length === 0) {
      return `<h2>${e(t.judul)}</h2><p class="kosong">Tidak ada data untuk filter ini.</p>`;
    }
    const dipotong = t.baris.length > maks;
    const baris = dipotong ? t.baris.slice(0, maks) : t.baris;
    const thead = `<tr>${t.kolom.map((k) => `<th>${e(k)}</th>`).join("")}</tr>`;
    const tbody = baris
      .map((r) => {
        const td = r.map((sel) => {
          const v = selHtml(sel);
          const kelas = [v.kanan ? "n" : "", v.tebal ? "b" : ""].filter(Boolean).join(" ");
          // Neutralised here too: this table gets pasted into Excel.
          return `<td${kelas ? ` class="${kelas}"` : ""}>${e(netralkanFormula(v.teks))}</td>`;
        });
        // A short row is padded so the grid stays rectangular.
        while (td.length < t.kolom.length) td.push("<td></td>");
        return `<tr>${td.join("")}</tr>`;
      })
      .join("");
    const catatan = dipotong
      ? `<p class="kosong">Ditampilkan ${maks} dari ${t.baris.length} baris. Gunakan ekspor Excel untuk seluruh isinya.</p>`
      : "";
    return `<h2>${e(t.judul)}</h2><table><thead>${thead}</thead><tbody>${tbody}</tbody></table>${catatan}`;
  });

  return (
    "<!doctype html><html lang=\"id\"><head><meta charset=\"utf-8\">" +
    `<title>${e(h.namaLaporan)} - ${e(h.periodeLabel)}</title>` +
    `<style>${GAYA}</style></head><body>` +
    `<div class="kop"><div class="bumn">${e(h.namaBumn)}</div>` +
    `<h1>${e(h.namaLaporan)}</h1>` +
    `<dl>${fakta.map(([k, v]) => `<dt>${e(k)}</dt><dd>${e(netralkanFormula(v))}</dd>`).join("")}</dl>` +
    "</div>" +
    bagian.join("") +
    "</body></html>"
  );
}

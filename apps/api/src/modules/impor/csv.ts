// A CSV reader, written here rather than pulled in.
//
// WHY NOT A LIBRARY. The grammar it has to accept is RFC 4180 and about
// seventy lines; a dependency for that would be an API-wide decision (this
// repo carries no parsing library at all) taken by one module for one file
// format. What it MUST get right is the security-relevant part, and that is
// small and specific:
//
//   - a quoted field may contain the delimiter, a newline, and doubled quotes;
//   - a row whose column count differs from the header is a REFUSED ROW with a
//     line number, never a row silently padded with nulls or truncated;
//   - a NUL byte anywhere refuses the whole file (Postgres `text` cannot hold
//     one, and the failure would otherwise arrive as a driver error halfway
//     through a commit);
//   - a UTF-8 BOM is stripped, because every spreadsheet in Indonesia writes
//     one and a header called "﻿kode_mitra" is a support ticket;
//   - LINE NUMBERS ARE 1-BASED AND COUNT THE HEADER, so the number in a
//     rejection is the number in the operator's spreadsheet. A row containing
//     a quoted newline reports the line it STARTED on.
//
// Nothing here interprets a field. A value that begins with `=`, `+`, `-` or
// `@` is data, and it stays data: this module never writes a CSV back out, so
// formula injection is a concern for whoever adds an export, and it is noted
// here so they see it.

export interface BarisCsv {
  /** 1-based, counting the header. */
  nomorBaris: number;
  nilai: Record<string, string>;
}

export interface HasilCsv {
  header: string[];
  baris: BarisCsv[];
  /** Rows whose column count did not match the header. */
  cacat: { nomorBaris: number; jumlahKolom: number }[];
}

/**
 * NOT named `*Error`, deliberately. core/http.ts recognises a domain error by
 * an ALLOWLIST of class names and `modules/closing/closing-rute-kesalahan.test.ts`
 * sweeps every `export class *Error extends Error` under apps/api/src/modules
 * to make sure each one is on it. This class carries no `kode`, never reaches
 * the error handler (./service.ts catches it at the one call site and
 * translates it into an `ImporError`), and registering it would put a
 * transport-less parse failure in a table of HTTP meanings. So it is named out
 * of the sweep instead of weakening the sweep.
 */
export class KesalahanCsv extends Error {
  readonly alasan: "NUL" | "KOSONG";
  constructor(alasan: "NUL" | "KOSONG", message: string) {
    super(message);
    this.name = "KesalahanCsv";
    this.alasan = alasan;
  }
}

/** Splits the text into rows of raw cells, tracking the line each row began on. */
function pisah(teks: string): { nomorBaris: number; sel: string[] }[] {
  const keluar: { nomorBaris: number; sel: string[] }[] = [];
  let sel: string[] = [];
  let buf = "";
  let dalamKutip = false;
  let baris = 1;
  let barisMulai = 1;
  let adaIsi = false;

  const tutupSel = (): void => {
    sel.push(buf);
    buf = "";
  };
  const tutupBaris = (): void => {
    tutupSel();
    // A trailing newline produces one empty cell; that is not a row.
    if (!(sel.length === 1 && sel[0] === "")) {
      keluar.push({ nomorBaris: barisMulai, sel });
    }
    sel = [];
    adaIsi = false;
    barisMulai = baris;
  };

  for (let i = 0; i < teks.length; i += 1) {
    const ch = teks[i]!;
    if (dalamKutip) {
      if (ch === '"') {
        if (teks[i + 1] === '"') {
          buf += '"';
          i += 1;
        } else {
          dalamKutip = false;
        }
      } else {
        if (ch === "\n") baris += 1;
        buf += ch;
      }
      continue;
    }
    if (ch === '"' && buf.length === 0) {
      dalamKutip = true;
      adaIsi = true;
      continue;
    }
    if (ch === ",") {
      tutupSel();
      adaIsi = true;
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      baris += 1;
      tutupBaris();
      barisMulai = baris;
      continue;
    }
    buf += ch;
    adaIsi = true;
  }
  if (adaIsi || buf.length > 0 || sel.length > 0) tutupBaris();
  return keluar;
}

/**
 * Parses a CSV into header plus rows keyed by header name. Values are trimmed;
 * nothing else is transformed.
 */
export function parseCsv(teks: string): HasilCsv {
  if (teks.includes("\u0000")) {
    throw new KesalahanCsv("NUL", "Berkas memuat byte NUL dan tidak bisa diproses.");
  }
  const bersih = teks.charCodeAt(0) === 0xfeff ? teks.slice(1) : teks;
  const mentah = pisah(bersih);
  if (mentah.length === 0) throw new KesalahanCsv("KOSONG", "Berkas tidak berisi apa-apa.");

  const barisHeader = mentah[0]!;
  const header = barisHeader.sel.map((h) => h.trim().toLowerCase());
  if (header.length === 0 || header.every((h) => h.length === 0)) {
    throw new KesalahanCsv("KOSONG", "Baris header tidak ditemukan.");
  }

  const baris: BarisCsv[] = [];
  const cacat: { nomorBaris: number; jumlahKolom: number }[] = [];
  for (const b of mentah.slice(1)) {
    // A row of only empty cells is a blank line in a spreadsheet, not a row.
    if (b.sel.every((v) => v.trim().length === 0)) continue;
    if (b.sel.length !== header.length) {
      cacat.push({ nomorBaris: b.nomorBaris, jumlahKolom: b.sel.length });
      continue;
    }
    const nilai: Record<string, string> = {};
    header.forEach((h, i) => {
      nilai[h] = (b.sel[i] ?? "").trim();
    });
    baris.push({ nomorBaris: b.nomorBaris, nilai });
  }
  return { header, baris, cacat };
}

/** SHA-256 of the exact text uploaded, hex. Provenance, and the idempotency key. */
export async function checksumTeks(teks: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(teks));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

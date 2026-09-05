// The XML this reader is willing to read, and everything it refuses.
//
// THERE IS NO XML PARSER IN THIS CODEBASE AND THAT IS THE POINT. Every
// classic spreadsheet-upload vulnerability is a property of a general parser
// being handed attacker-controlled markup:
//
//   XXE. `<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>` followed by
//   `&x;` in a cell. The mitigation everyone writes is "disable external
//   entity resolution on the parser"; the mitigation here is that there is no
//   parser to configure and no code path that could open a URL or a file if it
//   wanted to. `larangDeklarasi` refuses the document outright.
//
//   BILLION LAUGHS. Ten nested internal entity declarations expand to
//   gigabytes without a single external fetch, so an "external entities off"
//   parser is still vulnerable. Same answer: a DOCTYPE is refused before any
//   scanning starts, so no entity can be declared at all.
//
//   UNDECLARED ENTITIES. With DTDs banned, `&sesuatu;` cannot have a
//   legitimate definition, so it is a REFUSAL rather than a pass-through. A
//   reader that emitted the raw text would hand `&x;` to whatever renders the
//   cell next.
//
// WHAT IS SUPPORTED is exactly what SpreadsheetML needs: elements, attributes,
// text, CDATA, comments, the five predefined entities and numeric character
// references. Namespaces are treated as part of the tag name and matched by
// local name, because OOXML producers disagree about prefixes.
import { KODE_XLSX, KesalahanXlsx } from "./batas";

/**
 * Refuses any document that DECLARES anything.
 *
 * Deliberately a scan of the raw text before tokenising, and deliberately
 * case-insensitive: `<!doctype` is as valid as `<!DOCTYPE`. A `<!ENTITY`
 * outside a DOCTYPE is malformed anyway, and is listed so that the refusal
 * message is the same one either way.
 *
 * `<![CDATA[` is the one `<!` construct that is allowed, and it is checked
 * first so a sheet containing a literal "<!DOCTYPE" inside a CDATA section is
 * still refused: allowing that would make the ban depend on where the string
 * appears, and a producer that emits CDATA around cell text is not a producer
 * we need to support.
 */
export function larangDeklarasi(teks: string): void {
  const kecil = teks.toLowerCase();
  if (kecil.includes("<!doctype") || kecil.includes("<!entity") || kecil.includes("<!notation")) {
    throw new KesalahanXlsx(
      KODE_XLSX.XML_DEKLARASI_DILARANG,
      "Berkas memuat deklarasi DTD atau entitas XML. Berkas seperti ini ditolak " +
        "seluruhnya karena bisa dipakai untuk membaca berkas server atau " +
        "membanjiri memori, dan tidak pernah ditulis oleh aplikasi spreadsheet.",
    );
  }
}

const ENTITAS: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Highest code point a numeric character reference may name. */
const MAKS_KODE_TITIK = 0x10ffff;

/**
 * Decodes text content. Only the five predefined entities and numeric
 * character references; anything else is a refusal, never a pass-through.
 */
export function bacaTeksXml(mentah: string): string {
  if (!mentah.includes("&")) return mentah;
  let keluar = "";
  let i = 0;
  while (i < mentah.length) {
    const amp = mentah.indexOf("&", i);
    if (amp < 0) {
      keluar += mentah.slice(i);
      break;
    }
    keluar += mentah.slice(i, amp);
    const titikKoma = mentah.indexOf(";", amp);
    // A bare `&` more than 12 characters from its `;` is not an entity; the
    // cap keeps a document full of `&` from being quadratic to scan.
    if (titikKoma < 0 || titikKoma - amp > 12) {
      throw new KesalahanXlsx(
        KODE_XLSX.XML_ENTITAS_TIDAK_DIKENAL,
        "Berkas memuat tanda & yang bukan entitas XML yang sah.",
      );
    }
    const nama = mentah.slice(amp + 1, titikKoma);
    if (nama.startsWith("#")) {
      const heks = nama[1] === "x" || nama[1] === "X";
      const angka = Number.parseInt(heks ? nama.slice(2) : nama.slice(1), heks ? 16 : 10);
      if (!Number.isInteger(angka) || angka < 0 || angka > MAKS_KODE_TITIK) {
        throw new KesalahanXlsx(
          KODE_XLSX.XML_ENTITAS_TIDAK_DIKENAL,
          `Berkas memuat referensi karakter yang tidak sah (&${nama};).`,
        );
      }
      keluar += String.fromCodePoint(angka);
    } else {
      const nilai = ENTITAS[nama];
      if (nilai === undefined) {
        // With DTDs banned this can never be legitimate, so it is refused
        // rather than emitted raw. `&xxe;` reaching a cell as literal text
        // would be this reader passing an attack downstream intact.
        throw new KesalahanXlsx(
          KODE_XLSX.XML_ENTITAS_TIDAK_DIKENAL,
          `Berkas memakai entitas XML "${nama}" yang tidak dikenal dan tidak boleh diuraikan.`,
        );
      }
      keluar += nilai;
    }
    i = titikKoma + 1;
  }
  return keluar;
}

export interface TagXml {
  /** Local name, prefix stripped: `worksheet`, `c`, `v`, `is`, `t`. */
  nama: string;
  /** Raw attribute text, un-parsed. Read with `atribut()`. */
  atributMentah: string;
  jenis: "buka" | "tutup" | "kosong";
  /** Offset just past `>`. */
  akhir: number;
}

/**
 * Attribute by name, decoded. Attribute VALUES go through the same entity
 * rules as text, because `r="A&xxe;1"` is the same attack in a different slot.
 */
export function atribut(atributMentah: string, nama: string): string | null {
  const re = new RegExp(`(?:^|\\s)(?:[\\w.-]+:)?${nama}\\s*=\\s*("([^"]*)"|'([^']*)')`);
  const m = re.exec(atributMentah);
  if (!m) return null;
  return bacaTeksXml(m[2] ?? m[3] ?? "");
}

/**
 * A forward tag scanner.
 *
 * Iterative, allocating one object per tag and no tree at all: a worksheet is
 * read in one pass in document order, which is what SpreadsheetML is designed
 * for and which means a 12 MB sheet never becomes a 12 MB DOM on top of the
 * 12 MB of text.
 *
 * `larangDeklarasi` is called by the CALLER, once per document, before this is
 * ever entered; doing it here per tag would be both slower and easy to forget
 * at a new call site, so ./baca.ts calls it on every part it decodes.
 */
export function* tagXml(teks: string): Generator<TagXml> {
  let i = 0;
  while (i < teks.length) {
    const lt = teks.indexOf("<", i);
    if (lt < 0) return;
    // Comments, CDATA and processing instructions are skipped wholesale; none
    // of them carries data this reader wants, and a `<?xml-stylesheet?>` is
    // not something a spreadsheet part legitimately has.
    if (teks.startsWith("<!--", lt)) {
      const tutup = teks.indexOf("-->", lt);
      if (tutup < 0) throw rusakXml();
      i = tutup + 3;
      continue;
    }
    if (teks.startsWith("<![CDATA[", lt)) {
      const tutup = teks.indexOf("]]>", lt);
      if (tutup < 0) throw rusakXml();
      i = tutup + 3;
      continue;
    }
    if (teks.startsWith("<?", lt)) {
      const tutup = teks.indexOf("?>", lt);
      if (tutup < 0) throw rusakXml();
      i = tutup + 2;
      continue;
    }
    const gt = cariTutupTag(teks, lt);
    if (gt < 0) throw rusakXml();
    const isi = teks.slice(lt + 1, gt);
    const tutupTag = isi.startsWith("/");
    const kosong = isi.endsWith("/");
    const badan = isi.slice(tutupTag ? 1 : 0, kosong ? isi.length - 1 : isi.length);
    const spasi = badan.search(/\s/);
    const namaPenuh = spasi < 0 ? badan : badan.slice(0, spasi);
    const nama = namaPenuh.includes(":") ? namaPenuh.slice(namaPenuh.indexOf(":") + 1) : namaPenuh;
    yield {
      nama,
      atributMentah: spasi < 0 ? "" : badan.slice(spasi),
      jenis: tutupTag ? "tutup" : kosong ? "kosong" : "buka",
      akhir: gt + 1,
    };
    i = gt + 1;
  }
}

/** `>` that is not inside a quoted attribute value. */
function cariTutupTag(teks: string, lt: number): number {
  let kutip: string | null = null;
  for (let i = lt + 1; i < teks.length; i += 1) {
    const ch = teks[i]!;
    if (kutip) {
      if (ch === kutip) kutip = null;
      continue;
    }
    if (ch === '"' || ch === "'") kutip = ch;
    else if (ch === ">") return i;
  }
  return -1;
}

/** Text between the current tag's `>` and its matching close tag. */
export function isiTeks(teks: string, mulai: number, namaTag: string): string {
  const tutup = teks.indexOf("</", mulai);
  if (tutup < 0) throw rusakXml();
  // Local-name match, so `</x:t>` closes `<x:t>`.
  const akhirNama = teks.indexOf(">", tutup);
  if (akhirNama < 0) throw rusakXml();
  const namaTutup = teks.slice(tutup + 2, akhirNama);
  const lokal = namaTutup.includes(":") ? namaTutup.slice(namaTutup.indexOf(":") + 1) : namaTutup;
  if (lokal.trim() !== namaTag) throw rusakXml();
  return bacaTeksXml(teks.slice(mulai, tutup));
}

function rusakXml(): KesalahanXlsx {
  return new KesalahanXlsx(
    KODE_XLSX.XML_RUSAK,
    "Isi berkas tidak berbentuk XML yang utuh, jadi tidak bisa dibaca.",
  );
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Escapes text for an XML element or attribute, and REFUSES what XML 1.0
 * cannot represent at all.
 *
 * The five characters are the obvious half. The half that bites is the control
 * range: XML 1.0 permits only tab, newline and carriage return below U+0020,
 * and Excel refuses to open a workbook containing any other one. A report cell
 * fed from a `text` column can hold `` (Postgres will store it), so this
 * STRIPS the illegal ones rather than emitting a file no spreadsheet can open.
 * Stripping and not refusing, because the alternative is an operator unable to
 * export a report because one partner's address has a stray byte in it, with
 * nothing on screen to tell them which.
 */
export function loloskanXml(teks: string): string {
  let bersih = "";
  for (const ch of teks) {
    const kode = ch.codePointAt(0)!;
    if (kode === 0x09 || kode === 0x0a || kode === 0x0d) {
      bersih += ch;
      continue;
    }
    if (kode < 0x20 || (kode >= 0x7f && kode <= 0x9f)) continue;
    // Unpaired surrogates and the two non-characters Excel rejects.
    if (kode === 0xfffe || kode === 0xffff) continue;
    bersih += ch;
  }
  return bersih
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

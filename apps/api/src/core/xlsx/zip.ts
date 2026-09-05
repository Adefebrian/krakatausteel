// The ZIP container, read with hard bounds and written from scratch.
//
// WHY THIS IS NOT A LIBRARY, and the decision is recorded here rather than in a
// commit message because it is a SECURITY decision and it should be arguable
// from the code:
//
//   The reading side needs one thing no JavaScript spreadsheet library exposes:
//   a cap on the number of bytes DECOMPRESSION IS ALLOWED TO PRODUCE. Every
//   candidate either inflates a whole entry into a buffer sized from the
//   archive's own `uncompressed size` field (which the attacker writes), or
//   streams it into an unbounded accumulator. `node:zlib`, which Bun ships,
//   has `inflateRawSync(buf, { maxOutputLength })`, which throws
//   ERR_BUFFER_TOO_LARGE the moment the DEFLATE stream produces one byte more
//   than allowed, regardless of what any header claimed. That is the only
//   primitive in this whole file that has to be right, and it is not ours.
//
//   The writing side needs nothing at all: a ZIP with no directory entries, no
//   ZIP64, no encryption and no data descriptors is two fixed-layout records
//   and a CRC-32, and writing it here is what lets ./tulis.ts guarantee the
//   two properties that matter for an export -- an inert text cell and an
//   exact decimal number -- instead of hoping a library preserved them.
//
// SCOPE, deliberately narrow: STORED (0) and DEFLATE (8), no ZIP64, no
// encryption, no multi-disk, no data descriptors on read (the CENTRAL
// directory is the authority for every size, because the local header may
// legally carry zeroes). Anything outside that is REFUSED with its own code
// rather than guessed at, because a reader that guesses about a container
// format is a reader an attacker gets to steer.
import { deflateRawSync, inflateRawSync } from "node:zlib";
import {
  KODE_XLSX,
  KesalahanXlsx,
  MAKS_ENTRI,
  MAKS_ENTRI_DEKOMPRESI_BYTE,
  MAKS_PANJANG_NAMA_ENTRI,
  MAKS_TOTAL_DEKOMPRESI_BYTE,
} from "./batas";

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN = 22;
/** The ZIP comment field is 16 bits, so the EOCD starts at most this far back. */
const EOCD_CARI_MAKS = EOCD_MIN + 0xffff;

export interface EntriZip {
  nama: string;
  /** 0 = stored, 8 = deflate. Nothing else is accepted. */
  metode: number;
  compressedSize: number;
  /** What the CENTRAL DIRECTORY claims. Never trusted as an allocation size. */
  uncompressedSizeDiklaim: number;
  offsetHeaderLokal: number;
}

/** Bounds carried explicitly so a caller (and a test) can lower them. */
export interface BatasZip {
  maksEntri: number;
  maksEntriDekompresiByte: number;
  maksTotalDekompresiByte: number;
}

export const BATAS_ZIP_BAWAAN: BatasZip = {
  maksEntri: MAKS_ENTRI,
  maksEntriDekompresiByte: MAKS_ENTRI_DEKOMPRESI_BYTE,
  maksTotalDekompresiByte: MAKS_TOTAL_DEKOMPRESI_BYTE,
};

function u16(b: Uint8Array, i: number): number {
  if (i + 2 > b.length) throw rusak("struktur terpotong");
  return b[i]! | (b[i + 1]! << 8);
}

function u32(b: Uint8Array, i: number): number {
  if (i + 4 > b.length) throw rusak("struktur terpotong");
  return (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
}

function rusak(sebab: string): KesalahanXlsx {
  return new KesalahanXlsx(
    KODE_XLSX.ZIP_RUSAK,
    `Berkas tidak bisa dibaca sebagai arsip yang utuh (${sebab}).`,
  );
}

/**
 * An entry name we are willing to look at.
 *
 * Nothing in this reader ever writes an entry to disk, so traversal is not the
 * live risk it is in an unzip utility; the name is refused anyway. A path with
 * `..`, a leading `/`, a drive letter, a backslash or a NUL in it is not a name
 * any spreadsheet producer emits, and the cheapest moment to say so is before
 * the bytes are decompressed rather than after some later reader is handed the
 * string.
 */
function namaAman(nama: string): boolean {
  if (nama.length === 0 || nama.length > MAKS_PANJANG_NAMA_ENTRI) return false;
  // Control characters and a backslash are refused; a space is NOT, because a
  // legitimate producer may emit one and refusing a whole workbook over it is a
  // support ticket rather than a defence.
  if (/[\u0000-\u001f\u007f]/.test(nama) || nama.includes("\\")) return false;
  if (nama.startsWith("/") || /^[a-zA-Z]:/.test(nama)) return false;
  return !nama.split("/").includes("..");
}

/**
 * The central directory, validated. NOTHING IS DECOMPRESSED HERE: this is the
 * pass that decides which entries exist and refuses an archive whose shape is
 * already wrong, so a caller can pick the two or three entries it actually
 * needs instead of inflating everything to find out.
 */
export function bacaDirektoriZip(
  data: Uint8Array,
  batas: BatasZip = BATAS_ZIP_BAWAAN,
): EntriZip[] {
  if (data.length < EOCD_MIN) {
    throw new KesalahanXlsx(KODE_XLSX.BUKAN_ZIP, "Berkas terlalu pendek untuk sebuah arsip.");
  }
  // Backwards from the end, because the EOCD is last and may be followed by a
  // comment of up to 65535 bytes.
  let eocd = -1;
  const mulai = Math.max(0, data.length - EOCD_CARI_MAKS);
  for (let i = data.length - EOCD_MIN; i >= mulai; i -= 1) {
    if (u32(data, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new KesalahanXlsx(
      KODE_XLSX.BUKAN_ZIP,
      "Berkas ini bukan .xlsx: tidak ada penanda akhir arsip di dalamnya.",
    );
  }

  const jumlahEntri = u16(data, eocd + 10);
  const ukuranDirektori = u32(data, eocd + 12);
  const offsetDirektori = u32(data, eocd + 16);
  if (jumlahEntri === 0xffff || offsetDirektori === 0xffffffff || ukuranDirektori === 0xffffffff) {
    throw new KesalahanXlsx(
      KODE_XLSX.ZIP64_TIDAK_DIDUKUNG,
      "Arsip ini memakai format ZIP64, yang tidak dibaca oleh sistem ini.",
    );
  }
  if (jumlahEntri > batas.maksEntri) {
    throw new KesalahanXlsx(
      KODE_XLSX.TERLALU_BANYAK_ENTRI,
      `Arsip berisi ${jumlahEntri} bagian, melebihi batas ${batas.maksEntri}.`,
      batas.maksEntri,
    );
  }
  if (offsetDirektori + ukuranDirektori > data.length) throw rusak("direktori di luar berkas");

  const entri: EntriZip[] = [];
  let p = offsetDirektori;
  for (let n = 0; n < jumlahEntri; n += 1) {
    if (u32(data, p) !== SIG_CENTRAL) throw rusak("tanda direktori tidak cocok");
    const bendera = u16(data, p + 8);
    const metode = u16(data, p + 10);
    const compressedSize = u32(data, p + 20);
    const uncompressedSize = u32(data, p + 24);
    const panjangNama = u16(data, p + 28);
    const panjangExtra = u16(data, p + 30);
    const panjangKomentar = u16(data, p + 32);
    const offsetLokal = u32(data, p + 42);

    // Bit 0 is "encrypted". An encrypted entry cannot be read and must not be
    // silently skipped: a file whose sheet is encrypted would import as empty.
    if ((bendera & 0x0001) !== 0) {
      throw new KesalahanXlsx(
        KODE_XLSX.ZIP_TERENKRIPSI,
        "Berkas ini dilindungi kata sandi, jadi isinya tidak bisa dibaca.",
      );
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || offsetLokal === 0xffffffff) {
      throw new KesalahanXlsx(
        KODE_XLSX.ZIP64_TIDAK_DIDUKUNG,
        "Arsip ini memakai format ZIP64, yang tidak dibaca oleh sistem ini.",
      );
    }
    if (metode !== 0 && metode !== 8) {
      throw new KesalahanXlsx(
        KODE_XLSX.KOMPRESI_TIDAK_DIDUKUNG,
        `Bagian arsip memakai kompresi ${metode}, yang tidak didukung.`,
      );
    }

    const nama = new TextDecoder("utf-8", { fatal: false }).decode(
      data.subarray(p + 46, p + 46 + panjangNama),
    );
    if (!namaAman(nama)) {
      throw new KesalahanXlsx(
        KODE_XLSX.NAMA_ENTRI_TIDAK_AMAN,
        "Arsip berisi nama bagian yang tidak aman dan ditolak seluruhnya.",
      );
    }
    entri.push({
      nama,
      metode,
      compressedSize,
      uncompressedSizeDiklaim: uncompressedSize,
      offsetHeaderLokal: offsetLokal,
    });
    p += 46 + panjangNama + panjangExtra + panjangKomentar;
    if (p > offsetDirektori + ukuranDirektori) throw rusak("entri melewati akhir direktori");
  }
  return entri;
}

/**
 * A budget shared across every entry one archive is read through, so the TOTAL
 * cap is a property of the read and not of any single call.
 */
export class AnggaranDekompresi {
  private tersisa: number;

  constructor(
    private readonly batas: BatasZip = BATAS_ZIP_BAWAAN,
  ) {
    this.tersisa = batas.maksTotalDekompresiByte;
  }

  /** Bytes this entry is allowed to produce: the smaller of the two caps. */
  jatah(): number {
    return Math.min(this.batas.maksEntriDekompresiByte, this.tersisa);
  }

  pakai(byte: number): void {
    this.tersisa -= byte;
  }

  get sisa(): number {
    return this.tersisa;
  }

  get batasEntri(): number {
    return this.batas.maksEntriDekompresiByte;
  }

  get batasTotal(): number {
    return this.batas.maksTotalDekompresiByte;
  }
}

/**
 * Decompresses ONE entry under the budget.
 *
 * THE BOUND IS ON WHAT DEFLATE PRODUCES, NOT ON WHAT THE HEADER CLAIMS, and
 * that distinction is the whole defence. `uncompressedSizeDiklaim` is not used
 * to size anything here; `maxOutputLength` is, and `inflateRawSync` throws the
 * moment the stream exceeds it. An archive whose central directory says "100
 * bytes" and whose entry inflates to 20 MB is refused at 12 MB with
 * ENTRI_TERLALU_BESAR, which is the case a size-field check would have waved
 * through.
 */
export function bacaEntriZip(
  data: Uint8Array,
  entri: EntriZip,
  anggaran: AnggaranDekompresi,
): Uint8Array {
  const off = entri.offsetHeaderLokal;
  if (u32(data, off) !== SIG_LOCAL) throw rusak("tanda header lokal tidak cocok");
  const panjangNama = u16(data, off + 26);
  const panjangExtra = u16(data, off + 28);
  const mulai = off + 30 + panjangNama + panjangExtra;
  const akhir = mulai + entri.compressedSize;
  if (akhir > data.length) throw rusak("isi bagian melewati akhir berkas");
  const mentah = data.subarray(mulai, akhir);

  const jatah = anggaran.jatah();

  if (entri.metode === 0) {
    if (mentah.length > jatah) {
      throw lampauiBatas(entri.nama, mentah.length, jatah, anggaran);
    }
    anggaran.pakai(mentah.length);
    return new Uint8Array(mentah);
  }

  let keluar: Buffer;
  try {
    // `jatah + 1` so a stream that produces EXACTLY the cap is accepted and
    // one byte more is refused, rather than the cap itself being off by one.
    keluar = inflateRawSync(mentah, { maxOutputLength: jatah + 1 });
  } catch (err) {
    const kode = (err as { code?: string }).code;
    if (kode === "ERR_BUFFER_TOO_LARGE") {
      throw lampauiBatas(entri.nama, jatah + 1, jatah, anggaran);
    }
    throw rusak("isi terkompresi tidak bisa dibuka");
  }
  if (keluar.length > jatah) throw lampauiBatas(entri.nama, keluar.length, jatah, anggaran);
  anggaran.pakai(keluar.length);
  return new Uint8Array(keluar.buffer, keluar.byteOffset, keluar.byteLength);
}

/**
 * Which cap fired, said precisely. An operator whose legitimate 15 MB sheet was
 * refused and an attacker whose 4 x 10 MB archive was refused need different
 * sentences, and support needs to be able to tell the two apart from the log.
 */
function lampauiBatas(
  nama: string,
  dihasilkan: number,
  jatah: number,
  anggaran: AnggaranDekompresi,
): KesalahanXlsx {
  const totalYangMembatasi = jatah < anggaran.batasEntri;
  return totalYangMembatasi
    ? new KesalahanXlsx(
        KODE_XLSX.TOTAL_DEKOMPRESI_TERLALU_BESAR,
        `Isi berkas melebihi total ${Math.floor(anggaran.batasTotal / (1024 * 1024))} MB ` +
          "setelah dibuka, jadi berkas ditolak seluruhnya.",
        anggaran.batasTotal,
      )
    : new KesalahanXlsx(
        KODE_XLSX.ENTRI_TERLALU_BESAR,
        `Bagian "${nama}" melebihi ${Math.floor(anggaran.batasEntri / (1024 * 1024))} MB ` +
          `setelah dibuka (${dihasilkan} byte), jadi berkas ditolak seluruhnya.`,
        anggaran.batasEntri,
      );
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const TABEL_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) c = TABEL_CRC[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface BerkasZip {
  nama: string;
  isi: Uint8Array;
}

/**
 * A ZIP with a fixed DOS timestamp.
 *
 * THE TIMESTAMP IS CONSTANT ON PURPOSE. Two exports of the same closed period
 * by the same user must be byte-identical, so a reviewer can hash a workbook
 * and compare it with the one that was signed; a `now()` in the header would
 * make every export a different file with identical contents. The date a report
 * was printed is already IN the report (`header.tanggalCetak`, from the
 * engine's injected clock), which is where a reader looks for it.
 */
export function tulisZip(berkas: readonly BerkasZip[]): Uint8Array {
  const potongan: Uint8Array[] = [];
  const direktori: Uint8Array[] = [];
  let offset = 0;

  // 1980-01-01 00:00:00 in DOS format: the epoch of the format itself.
  const dosWaktu = 0;
  const dosTanggal = 0x0021;

  for (const b of berkas) {
    const nama = new TextEncoder().encode(b.nama);
    const mentah = b.isi;
    const padat = deflateRawSync(mentah, { level: 6 });
    // Storing is smaller than deflating for tiny, incompressible parts.
    const pakaiDeflate = padat.length < mentah.length;
    const isi = pakaiDeflate ? new Uint8Array(padat) : mentah;
    const metode = pakaiDeflate ? 8 : 0;
    const crc = crc32(mentah);

    const lokal = new Uint8Array(30 + nama.length);
    const dvl = new DataView(lokal.buffer);
    dvl.setUint32(0, SIG_LOCAL, true);
    dvl.setUint16(4, 20, true); // version needed
    dvl.setUint16(6, 0x0800, true); // UTF-8 names
    dvl.setUint16(8, metode, true);
    dvl.setUint16(10, dosWaktu, true);
    dvl.setUint16(12, dosTanggal, true);
    dvl.setUint32(14, crc, true);
    dvl.setUint32(18, isi.length, true);
    dvl.setUint32(22, mentah.length, true);
    dvl.setUint16(26, nama.length, true);
    dvl.setUint16(28, 0, true);
    lokal.set(nama, 30);

    const pusat = new Uint8Array(46 + nama.length);
    const dvc = new DataView(pusat.buffer);
    dvc.setUint32(0, SIG_CENTRAL, true);
    dvc.setUint16(4, 20, true); // version made by
    dvc.setUint16(6, 20, true); // version needed
    dvc.setUint16(8, 0x0800, true);
    dvc.setUint16(10, metode, true);
    dvc.setUint16(12, dosWaktu, true);
    dvc.setUint16(14, dosTanggal, true);
    dvc.setUint32(16, crc, true);
    dvc.setUint32(20, isi.length, true);
    dvc.setUint32(24, mentah.length, true);
    dvc.setUint16(28, nama.length, true);
    dvc.setUint32(42, offset, true);
    pusat.set(nama, 46);

    potongan.push(lokal, isi);
    direktori.push(pusat);
    offset += lokal.length + isi.length;
  }

  const ukuranDirektori = direktori.reduce((t, d) => t + d.length, 0);
  const eocd = new Uint8Array(EOCD_MIN);
  const dve = new DataView(eocd.buffer);
  dve.setUint32(0, SIG_EOCD, true);
  dve.setUint16(8, berkas.length, true);
  dve.setUint16(10, berkas.length, true);
  dve.setUint32(12, ukuranDirektori, true);
  dve.setUint32(16, offset, true);

  const semua = [...potongan, ...direktori, eocd];
  const total = semua.reduce((t, s) => t + s.length, 0);
  const keluar = new Uint8Array(total);
  let p = 0;
  for (const s of semua) {
    keluar.set(s, p);
    p += s.length;
  }
  return keluar;
}

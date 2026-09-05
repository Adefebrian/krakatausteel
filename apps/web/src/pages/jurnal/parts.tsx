// Pieces the seven journal screens of spec 9.4 are built from, so a document
// list, a verification queue, a posting queue and a reversal picker read as one
// module rather than as four ways of drawing the same rows.
//
// SIX RULES LIVE HERE, ONCE EACH.
//
//   A DRAFT THAT HAS BEEN VERIFIED IS NOT A SEPARATE STATUS, AND THE BADGE
//   SAYS SO. The database CHECK on `jurnal.status` allows three values, DRAFT,
//   POSTED and REVERSED; verification stamps `verified_by` and `verified_at`
//   and leaves the status alone. A badge that printed only "Draft" would make a
//   Checker's work invisible on every list in the module, and a badge that
//   printed "Terverifikasi" as if it were a status would invent a fourth state
//   the ledger does not have. So the badge prints "Draft terverifikasi" and
//   keeps `data-status="DRAFT"`, which is what the row actually is.
//
//   A REVERSED DOCUMENT IS STILL IN THE LEDGER, and nothing in this module is
//   allowed to draw it as removed. ADR 0010: the correction pair is two rows
//   added and none taken away, `v_ledger_baris` counts POSTED and REVERSED, and
//   the pair nets to zero. `BadgeJurnal` tones REVERSED as a note, never as a
//   deletion, and `TautanPasangan` links the two halves by document number so
//   neither is ever read alone.
//
//   MONEY GOES THROUGH packages/ui, AND ABSENT IS NOT UNREADABLE. A journal
//   total is always a figure and always renders as one. A field that is
//   legitimately empty (no note, no counterparty) prints words, never the
//   "tidak sah" marker: the marker means "this arrived and could not be read",
//   and once it appears where it does not belong a reader stops trusting it
//   where it does.
//
//   THE FORM NEVER RE-DECIDES WHETHER A JOURNAL IS VALID. Balance, the
//   two-line minimum, "exactly one of debit and kredit", whether an account is
//   postable and whether the period is open are the ENGINE's rules, each stated
//   once with its own code. `EditorBaris` shows a running total because an
//   accountant needs to see one, and the submit control closes over what the
//   form itself can see (an amount it could not read, a line with no account);
//   the refusal always comes from the server, and `pesanUntukField` puts it on
//   the field it belongs to.
//
//   AN AMOUNT IS TYPED ONCE, ON ONE SIDE. The engine requires exactly one of
//   debit and kredit per line, so the editor asks for a POSITION and an AMOUNT
//   rather than for two boxes an operator can fill both of. A form that can
//   express an invalid line is a form that will.
//
//   NOTHING HERE DELETES A POSTED JOURNAL, because the API has no route that
//   could. `AksiDraft` cancels a DRAFT and says so in those words; correction
//   after posting is ./Pembalik.tsx and nothing else.
import { useMemo, useState, type ReactNode } from "react";
import {
  Button,
  DataTable,
  Field,
  Icon,
  MoneyInput,
  Panel,
  Select,
  StatusBadge,
  Textarea,
  TextInput,
  formatCount,
  formatDate,
  formatMoney,
  formatPeriode,
  jumlahkanUang,
  kurangkanUang,
  STATUS_PERIODE,
  type Column,
} from "@krakatausteel/ui";
import {
  BATAS_DAFTAR_JURNAL,
  buatJurnal,
  LABEL_JALUR,
  LABEL_JENIS,
  type BarisJurnalInput,
  type BarisJurnalTampil,
  type DimensiBaris,
  type InputJurnalManual,
  type Jurnal,
  type JurnalTampil,
  type RingkasanJurnal,
} from "../../api/jurnal";
import {
  baganAkun,
  periodeLaporan,
  type BarisBaganAkun,
  type LaporanBaganAkun,
} from "../../api/laporan";
import { galatField, kodeDomain, pesanKesalahan } from "../../api/http";
import { useApi, type HasilApi } from "../../api/useApi";
import { Link } from "../../router";
import { useActiveSession } from "../../session";
import {
  Bagian,
  DaftarDokumen,
  FieldGrid,
  type ColumnSpec,
  type KartuBaris,
} from "../shared/parts";

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** True when a DRAFT has been through a Checker. See this file's header. */
export function sudahDiverifikasi(row: { status: string; verifiedAt: string | null }): boolean {
  return row.status === "DRAFT" && row.verifiedAt !== null;
}

export function BadgeJurnal({
  status,
  verifiedAt,
}: {
  status: string;
  verifiedAt: string | null;
}) {
  if (sudahDiverifikasi({ status, verifiedAt })) {
    return <StatusBadge status="DRAFT" tone="info" label="Draft terverifikasi" />;
  }
  return <StatusBadge status={status} />;
}

/** The document type, spelled out. An unmapped type still reads legibly. */
export function labelJenis(jenis: string): string {
  return LABEL_JENIS[jenis] ?? jenis;
}

/** Where the row came from. Absent is words, never a blank cell. */
export function labelJalur(jalur: string | null): string {
  if (jalur === null) return "tidak tercatat";
  return LABEL_JALUR[jalur] ?? jalur;
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/**
 * The chart of accounts, from `GET /laporan/bagan-akun`.
 *
 * IT IS THE ONLY FULL COA READ A MAKER CAN MAKE. `GET /konfigurasi/akun`
 * answers cash accounts alone and refuses without `kas=true`, and the master
 * chart screen sits behind `konfigurasi.coa`, which the Maker does not hold.
 * The report read is gated on `laporan.view`, which every operational role has,
 * so the account picker on a journal form works for the person who fills it in.
 *
 * ONLY POSTABLE ACCOUNTS ARE OFFERED. A header account is refused by the engine
 * with `AKUN_TIDAK_POSTABLE` (validation 6.2.6); offering one in the picker
 * would be offering a choice the server exists to refuse. Inactive accounts are
 * dropped for the same reason.
 */
export function useAkun(): HasilApi<LaporanBaganAkun> {
  return useApi(() => baganAkun(true), []);
}

export function akunPostable(baris: readonly BarisBaganAkun[]): BarisBaganAkun[] {
  return baris.filter((akun) => akun.isPostable && akun.aktif);
}

export function opsiAkun(baris: readonly BarisBaganAkun[]) {
  return akunPostable(baris).map((akun) => ({
    value: akun.akunId,
    label: `${akun.kode} ${akun.nama}`,
  }));
}

/** Accounting periods, for the list filter. Newest first, as the API sends. */
export function usePeriode() {
  return useApi(() => periodeLaporan(), []);
}

/**
 * A period as an operator names it, with its own state next to it.
 *
 * `OpsiPeriode` carries `tahun` and `bulan` and no printed label, so the label
 * is built here, once, through `formatPeriode` in packages/ui. Building it
 * inline on each screen is how "Maret 2026" and "2026-03" end up on two pages
 * of the same module.
 */
export function labelPeriode(periode: {
  tahun: number;
  bulan: number;
  status: string;
}): string {
  const nama = STATUS_PERIODE[periode.status]?.label ?? periode.status;
  return `${formatPeriode(periode.tahun, periode.bulan)} (${nama})`;
}

// ---------------------------------------------------------------------------
// Server refusals, put on the field they belong to
// ---------------------------------------------------------------------------

/**
 * The per-field message for a boundary validation, keyed by the ROUTER's own
 * field path (`baris.2.akunId`, `tanggalTransaksi`).
 *
 * Nothing is renumbered and nothing is reworded: the path the server used is
 * the path this looks up, so a message can never end up on the wrong line.
 */
export function pesanUntukField(
  galat: Record<string, string[]> | null,
  field: string,
): string | undefined {
  const pesan = galat?.[field];
  return pesan && pesan.length > 0 ? pesan.join(". ") : undefined;
}

/**
 * The FIELD a domain refusal belongs to, for the three codes whose cause is a
 * specific control on a specific form.
 *
 * These are not restatements of the engine's rules and they do not decide
 * anything: the engine has already refused, and this only routes its sentence
 * to the control the operator has to change. A code that is not here shows in
 * the form's own error row, which is the right place for "that period is
 * closed" and "you filed it, so you cannot verify it".
 */
export const FIELD_UNTUK_KODE: Record<string, string> = {
  KAS_BANK_TANPA_AKUN_KAS: "akunKas",
  PINBUK_AKUN_SALAH: "akunBeban",
  PINBUK_TANPA_TAUTAN: "tautan",
  PINBUK_KATEGORI_TIDAK_VALID: "kategori",
};

// ---------------------------------------------------------------------------
// The document list, one shape for all four screens that show one
// ---------------------------------------------------------------------------

function kolomJurnal(): readonly ColumnSpec<RingkasanJurnal>[] {
  return [
    { key: "noJurnal", header: "Nomor jurnal", sortable: true, width: "180px" },
    { key: "tanggalTransaksi", header: "Tanggal", type: "date", sortable: true, width: "120px" },
    {
      key: "jenis",
      header: "Jenis",
      width: "150px",
      render: (row) => labelJenis(row.jenis),
    },
    {
      key: "keterangan",
      header: "Keterangan",
      render: (row) => (
        <span className="sel-keterangan">{row.keterangan ?? "tanpa keterangan"}</span>
      ),
    },
    { key: "totalDebit", header: "Debit", type: "money", sortable: true, width: "150px" },
    { key: "totalKredit", header: "Kredit", type: "money", sortable: true, width: "150px" },
    {
      key: "status",
      header: "Status",
      width: "170px",
      render: (row) => <BadgeJurnal status={row.status} verifiedAt={row.verifiedAt} />,
    },
  ];
}

function kartuJurnal(row: RingkasanJurnal): KartuBaris {
  return {
    judul: row.noJurnal,
    sub: `${labelJenis(row.jenis)} . ${formatDate(row.tanggalTransaksi)}`,
    meta: row.cabangKode,
    nilai: formatMoney(row.totalDebit),
    nilaiLabel: "Total debit",
    status: <BadgeJurnal status={row.status} verifiedAt={row.verifiedAt} />,
  };
}

/**
 * The document list. One table on a desk, one card per row on a phone, both
 * driven by the same rows so they can never disagree about what is in the list.
 */
export function DaftarJurnalTabel({
  rows,
  onPilih,
  emptyTitle,
  emptyDescription,
  caption,
}: {
  rows: readonly RingkasanJurnal[];
  onPilih?: (row: RingkasanJurnal) => void;
  emptyTitle: string;
  emptyDescription: string;
  caption?: string;
}) {
  return (
    <DaftarDokumen
      columns={kolomJurnal()}
      rows={rows}
      rowKey={(row) => row.id}
      kartu={kartuJurnal}
      onPilih={onPilih}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
      caption={caption}
    />
  );
}

/** The sentence a list shows when it has hit the server's own ceiling. */
export function CatatanBatas({ jumlah }: { jumlah: number }) {
  if (jumlah < BATAS_DAFTAR_JURNAL) return null;
  return (
    <p className="page-note">
      <Icon name="info" size={16} />
      <span>
        Daftar dipotong server pada {formatCount(BATAS_DAFTAR_JURNAL)} dokumen. Persempit dengan
        filter periode, cabang, tanggal, atau pencarian nomor dokumen supaya yang Anda cari pasti
        ikut terbaca.
      </span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// One document, opened
// ---------------------------------------------------------------------------

const KOLOM_BARIS: readonly Column<BarisJurnalTampil>[] = [
  { key: "urutan", header: "No", type: "count", width: "60px" },
  {
    key: "akunKode",
    header: "Akun",
    render: (row) => (
      <span className="sel-akun">
        <span className="sel-akun-kode">{row.akunKode}</span>
        <span className="sel-akun-nama">{row.akunNama}</span>
      </span>
    ),
  },
  {
    key: "keterangan",
    header: "Keterangan baris",
    render: (row) => row.keterangan ?? "tanpa keterangan",
  },
  {
    key: "subledger",
    header: "Sub ledger",
    width: "180px",
    render: (row) =>
      row.mitraNama === null && row.akadNo === null
        ? "tidak ada"
        : [row.mitraNama, row.akadNo].filter(Boolean).join(" . "),
  },
  { key: "debit", header: "Debit", type: "money", width: "150px" },
  { key: "kredit", header: "Kredit", type: "money", width: "150px" },
];

/** The lines of one document, with the totals on the table's own footer row. */
export function TabelBaris({ baris }: { baris: readonly BarisJurnalTampil[] }) {
  const kolom = useMemo<readonly Column<BarisJurnalTampil>[]>(
    () =>
      KOLOM_BARIS.map((k) =>
        k.key === "debit"
          ? { ...k, footer: formatMoney(jumlahkanUang(baris.map((b) => b.debit)) ?? "0.00") }
          : k.key === "kredit"
            ? { ...k, footer: formatMoney(jumlahkanUang(baris.map((b) => b.kredit)) ?? "0.00") }
            : k.key === "urutan"
              ? { ...k, footer: "Total" }
              : k,
      ),
    [baris],
  );
  return (
    <div className="daftar-tabel">
      <DataTable
        columns={kolom}
        rows={baris}
        rowKey={(row) => row.id}
        caption="Baris jurnal, urutan sesuai dokumen"
        emptyTitle="Dokumen ini tidak punya baris"
        emptyDescription="Jurnal tanpa baris tidak bisa diposting; engine menolaknya dengan MINIMAL_DUA_BARIS."
      />
    </div>
  );
}

/** The phone shape of the same lines. One fixed card, whatever a line carries. */
export function KartuBarisJurnal({ baris }: { baris: readonly BarisJurnalTampil[] }) {
  return (
    <ul className="baris-kartu-list">
      {baris.map((row) => (
        <li className="baris-kartu" key={row.id}>
          <span className="baris-kartu-head">
            <span className="baris-kartu-kode">{row.akunKode}</span>
            <span className="baris-kartu-sisi">
              {row.debit !== "0.00" ? "Debit" : "Kredit"}
            </span>
          </span>
          <span className="baris-kartu-nama">{row.akunNama}</span>
          <span className="baris-kartu-foot">
            <span className="baris-kartu-ket">{row.keterangan ?? "tanpa keterangan"}</span>
            <span className="baris-kartu-nilai">
              {formatMoney(row.debit !== "0.00" ? row.debit : row.kredit)}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A link to the other half of a correction pair, by document number. */
export function TautanPasangan({
  label,
  pasangan,
}: {
  label: string;
  pasangan: { id: string; noJurnal: string } | null;
}) {
  if (!pasangan) return null;
  return (
    <p className="page-note">
      <Icon name="info" size={16} />
      <span>
        {label}{" "}
        <Link className="tautan-dokumen" to={`/jurnal?dokumen=${encodeURIComponent(pasangan.id)}`}>
          {pasangan.noJurnal}
        </Link>
        . Kedua dokumen tetap ada di buku besar dan saling menghapus, tidak ada yang dibuang.
      </span>
    </p>
  );
}

/** The header facts of one document, in the same card shape everywhere. */
export function RingkasJurnal({ jurnal }: { jurnal: JurnalTampil }) {
  const fakta: readonly { label: string; nilai: ReactNode }[] = [
    { label: "Nomor jurnal", nilai: jurnal.noJurnal },
    { label: "Jenis", nilai: labelJenis(jurnal.jenis) },
    { label: "Tanggal transaksi", nilai: formatDate(jurnal.tanggalTransaksi) },
    { label: "Periode", nilai: jurnal.periodeLabel },
    { label: "Cabang", nilai: `${jurnal.cabangKode} ${jurnal.cabangNama}` },
    { label: "Total debit", nilai: formatMoney(jurnal.totalDebit) },
    { label: "Total kredit", nilai: formatMoney(jurnal.totalKredit) },
    { label: "Jumlah baris", nilai: formatCount(jurnal.jumlahBaris) },
    { label: "Dibuat oleh", nilai: jurnal.dibuatOleh ?? "tidak tercatat" },
    {
      label: "Diverifikasi oleh",
      nilai:
        jurnal.diverifikasiOleh === null
          ? "belum diverifikasi"
          : `${jurnal.diverifikasiOleh} . ${formatDate(jurnal.verifiedAt)}`,
    },
    {
      label: "Diposting oleh",
      nilai:
        jurnal.dipostingOleh === null
          ? "belum diposting"
          : `${jurnal.dipostingOleh} . ${formatDate(jurnal.postedAt)}`,
    },
    { label: "Jalur posting", nilai: labelJalur(jurnal.jalurPosting) },
  ];
  return (
    <dl className="fakta-grid">
      {fakta.map((item) => (
        <div className="fakta-item" key={item.label}>
          <dt className="fakta-key">{item.label}</dt>
          <dd className="fakta-val">{item.nilai}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One document, opened: facts, then lines, then the pair it belongs to. */
export function DokumenJurnal({
  jurnal,
  aksi,
}: {
  jurnal: JurnalTampil;
  aksi?: ReactNode;
}) {
  return (
    <Panel
      as="h2"
      title={`Dokumen ${jurnal.noJurnal}`}
      description="Isi dokumen apa adanya, termasuk baris, sub ledger, dan siapa yang menyentuhnya."
      aside={<BadgeJurnal status={jurnal.status} verifiedAt={jurnal.verifiedAt} />}
      footer={
        <span className="panel-foot-note">
          Sumber: GET /api/jurnal/{jurnal.id}. Kewenangan jurnal.view.
        </span>
      }
    >
      <RingkasJurnal jurnal={jurnal} />
      <TabelBaris baris={jurnal.baris} />
      <div className="daftar-kartu">
        <KartuBarisJurnal baris={jurnal.baris} />
      </div>
      <TautanPasangan
        label="Dokumen ini dibalik oleh"
        pasangan={jurnal.dibalikOleh}
      />
      <TautanPasangan label="Dokumen ini membalik" pasangan={jurnal.pembalik} />
      {aksi ? <div className="form-actions-row">{aksi}</div> : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// The line editor
// ---------------------------------------------------------------------------

export type Sisi = "DEBIT" | "KREDIT";

export interface BarisForm {
  /** Local key only. Never sent: the engine allocates its own line ids. */
  kunci: string;
  akunId: string;
  sisi: Sisi;
  /** A `Uang` string, or "" for an empty field. */
  jumlah: string;
  /** False when the typed text is not a figure. Null is never sent as zero. */
  terbaca: boolean;
  keterangan: string;
  mitraId: string | null;
  akadId: string | null;
  dimensi?: DimensiBaris;
}

let urutKunci = 0;

export function barisKosong(sisi: Sisi = "DEBIT"): BarisForm {
  urutKunci += 1;
  return {
    kunci: `baris-${urutKunci}`,
    akunId: "",
    sisi,
    jumlah: "",
    terbaca: true,
    keterangan: "",
    mitraId: null,
    akadId: null,
  };
}

/** Two empty lines, because a journal with one line is not a journal. */
export function barisAwal(): BarisForm[] {
  return [barisKosong("DEBIT"), barisKosong("KREDIT")];
}

export function keInputBaris(baris: readonly BarisForm[]): BarisJurnalInput[] {
  return baris.map((row) => ({
    akunId: row.akunId,
    ...(row.sisi === "DEBIT" ? { debit: row.jumlah } : { kredit: row.jumlah }),
    keterangan: row.keterangan.trim() === "" ? null : row.keterangan.trim(),
    mitraId: row.mitraId,
    akadId: row.akadId,
    ...(row.dimensi ? { dimensi: row.dimensi } : {}),
  }));
}

export interface RingkasTotal {
  debit: string;
  kredit: string;
  selisih: string | null;
  seimbang: boolean;
}

/**
 * The running total, in integer cents through packages/ui, never through a
 * float. It is a DISPLAY of what has been typed, not a second opinion about
 * whether the document is valid: the engine states that once, and refuses.
 */
export function hitungTotal(baris: readonly BarisForm[]): RingkasTotal {
  const debit = jumlahkanUang(baris.filter((b) => b.sisi === "DEBIT").map((b) => b.jumlah)) ?? "0.00";
  const kredit =
    jumlahkanUang(baris.filter((b) => b.sisi === "KREDIT").map((b) => b.jumlah)) ?? "0.00";
  const selisih = kurangkanUang(debit, kredit);
  return { debit, kredit, selisih, seimbang: selisih === "0.00" };
}

/**
 * What the FORM itself can see is wrong, in the operator's words. It is
 * deliberately short: an amount that could not be read, a line with no account,
 * fewer than two lines, and an imbalance. Everything else is the engine's to
 * say, and it says it with its own code.
 */
export function keluhanForm(baris: readonly BarisForm[], total: RingkasTotal): string[] {
  const keluhan: string[] = [];
  if (baris.length < 2) keluhan.push("Jurnal harus punya minimal dua baris.");
  if (baris.some((b) => b.akunId === "")) keluhan.push("Masih ada baris tanpa akun.");
  if (baris.some((b) => !b.terbaca)) {
    keluhan.push("Ada nilai yang tidak terbaca sebagai angka rupiah.");
  }
  if (baris.some((b) => b.terbaca && (b.jumlah === "" || b.jumlah === "0.00"))) {
    keluhan.push("Setiap baris harus bernilai lebih dari nol.");
  }
  if (!total.seimbang) {
    keluhan.push(
      total.selisih === null
        ? "Selisih debit dan kredit belum dapat dihitung karena ada nilai yang tidak terbaca."
        : `Debit dan kredit belum sama, selisih ${formatMoney(total.selisih)}.`,
    );
  }
  return keluhan;
}

const OPSI_SISI = [
  { value: "DEBIT", label: "Debit" },
  { value: "KREDIT", label: "Kredit" },
];

/**
 * The line editor. One row shape, whatever a line carries: account, position,
 * amount, note, and a remove control that is never the only 44px target in the
 * row.
 *
 * `kunciAkun` locks one line's account picker (the cash account on a Kas Bank
 * entry, the preset expense account on a Pinbuk entry), so the form that owns a
 * fixed leg does not have to draw its own editor.
 */
export function EditorBaris({
  baris,
  onChange,
  akun,
  galat,
  terkunci,
  aksiBaris,
}: {
  baris: readonly BarisForm[];
  onChange: (baris: BarisForm[]) => void;
  akun: readonly BarisBaganAkun[];
  /** Per field messages from the server, keyed `baris.<i>.<field>`. */
  galat: Record<string, string[]> | null;
  /** Line indexes whose account is fixed by the form. */
  terkunci?: ReadonlySet<number>;
  /** Extra control under one line, e.g. the Pinbuk sub ledger link. */
  aksiBaris?: (index: number, row: BarisForm) => ReactNode;
}) {
  const opsi = useMemo(() => opsiAkun(akun), [akun]);

  function ubah(index: number, patch: Partial<BarisForm>) {
    onChange(baris.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  }

  return (
    <div className="baris-editor">
      <ul className="baris-editor-list">
        {baris.map((row, index) => (
          /*
            THE REACT KEY AND THE DOM ID ARE DIFFERENT THINGS ON PURPOSE.

            `row.kunci` is a value that never repeats, which is what keeps a
            line's input from being reused for its neighbour when a line is
            removed from the middle. The DOM id is the line's POSITION, because
            that is what its own label says ("Akun baris 2") and what a person,
            a screen reader and the server's `baris.1.akunId` all mean by "the
            second line". An id built from the unique key changes on every
            mount, which makes every label and every server message point at a
            control nobody can name.
          */
          <li className="baris-editor-item" key={row.kunci}>
            <div className="baris-editor-grid">
              <Field
                label={`Akun baris ${index + 1}`}
                htmlFor={`baris-${index + 1}-akun`}
                required
                error={pesanUntukField(galat, `baris.${index}.akunId`)}
              >
                <Select
                  id={`baris-${index + 1}-akun`}
                  value={row.akunId}
                  disabled={terkunci?.has(index) ?? false}
                  onChange={(event) => ubah(index, { akunId: event.currentTarget.value })}
                  options={[{ value: "", label: "Pilih akun" }, ...opsi]}
                />
              </Field>
              <Field label={`Posisi baris ${index + 1}`} htmlFor={`baris-${index + 1}-sisi`} required>
                <Select
                  id={`baris-${index + 1}-sisi`}
                  value={row.sisi}
                  onChange={(event) =>
                    ubah(index, { sisi: event.currentTarget.value as Sisi })
                  }
                  options={OPSI_SISI}
                />
              </Field>
              <Field
                label={`Jumlah baris ${index + 1}`}
                htmlFor={`baris-${index + 1}-jumlah`}
                required
                error={
                  row.terbaca
                    ? (pesanUntukField(galat, `baris.${index}.debit`) ??
                      pesanUntukField(galat, `baris.${index}.kredit`))
                    : "Nilai tidak terbaca sebagai angka rupiah."
                }
              >
                <MoneyInput
                  id={`baris-${index + 1}-jumlah`}
                  value={row.jumlah}
                  invalid={!row.terbaca}
                  onValueChange={(nilai, mentah) =>
                    ubah(index, {
                      jumlah: nilai ?? "",
                      terbaca: mentah.trim() === "" || nilai !== null,
                    })
                  }
                />
              </Field>
              <Field
                label={`Keterangan baris ${index + 1}`}
                htmlFor={`baris-${index + 1}-ket`}
                error={pesanUntukField(galat, `baris.${index}.keterangan`)}
              >
                <TextInput
                  id={`baris-${index + 1}-ket`}
                  value={row.keterangan}
                  maxLength={1000}
                  onChange={(event) => ubah(index, { keterangan: event.currentTarget.value })}
                />
              </Field>
            </div>
            {aksiBaris ? <div className="baris-editor-extra">{aksiBaris(index, row)}</div> : null}
            {/*
              THE REMOVE CONTROL IS ABSENT AT TWO LINES, NOT DISABLED.

              A journal cannot have fewer than two lines, so at two the control
              can never be used, and a permanently greyed button left a dead
              strip across the bottom of every card. Absent at two and present
              on EVERY card from three onwards, so the list still reads as one
              shape at any length. Seen at 1440, not caught by a test.
            */}
            {baris.length > 2 ? (
              <div className="baris-editor-aksi">
                <Button
                  variant="ghost"
                  size="sm"
                  leading={<Icon name="trash" size={16} />}
                  onClick={() => onChange(baris.filter((_, at) => at !== index))}
                >
                  Hapus baris {index + 1}
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="baris-editor-tambah">
        <Button
          variant="secondary"
          size="sm"
          leading={<Icon name="plus" size={16} />}
          onClick={() => onChange([...baris, barisKosong(baris.length % 2 === 0 ? "DEBIT" : "KREDIT")])}
        >
          Tambah baris
        </Button>
      </div>
    </div>
  );
}

/** The running total card, in one shape, on every form that has lines. */
export function TotalBerjalan({ total }: { total: RingkasTotal }) {
  return (
    <div className="total-berjalan">
      <div className="total-item">
        <span className="total-key">Total debit</span>
        <span className="total-val">{formatMoney(total.debit)}</span>
      </div>
      <div className="total-item">
        <span className="total-key">Total kredit</span>
        <span className="total-val">{formatMoney(total.kredit)}</span>
      </div>
      <div className={total.seimbang ? "total-item is-seimbang" : "total-item is-selisih"}>
        <span className="total-key">Selisih</span>
        <span className="total-val">
          {total.selisih === null ? "belum dapat dihitung" : formatMoney(total.selisih)}
        </span>
      </div>
    </div>
  );
}

/** The note every journal form carries. Spec 6.3, and it is not decoration. */
export function CatatanAlurJurnal() {
  return (
    <p className="page-note">
      <Icon name="info" size={16} />
      <span>
        Dokumen yang disimpan di sini selalu lahir sebagai DRAFT dan belum masuk buku besar. Draft
        diverifikasi Checker, lalu diposting Approver. Setelah POSTED, dokumen tidak bisa diubah
        atau dihapus, dan koreksinya hanya lewat jurnal pembalik.
      </span>
    </p>
  );
}

/** A short, reusable "pick a document first" panel body. */
export function PilihDokumen({
  judul,
  keterangan,
}: {
  judul: string;
  keterangan: string;
}) {
  return (
    <div className="antrean-kosong">
      <span className="antrean-kosong-icon" aria-hidden="true">
        <Icon name="jurnal" size={20} />
      </span>
      <p className="antrean-kosong-title">{judul}</p>
      <p className="antrean-kosong-desc">{keterangan}</p>
    </div>
  );
}

/**
 * A checkbox in one shape, for the two queues that select rows in bulk.
 * A real input with a real label, so it is keyboard reachable and 44px tall.
 */
export function KotakPilih({
  id,
  label,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="kotak-pilih" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="kotak-pilih-teks">{label}</span>
    </label>
  );
}

/** Local state for a bulk selection, so two queues share one behaviour. */
export function usePilihanBanyak() {
  const [terpilih, setTerpilih] = useState<readonly string[]>([]);
  return {
    terpilih,
    kosongkan: () => setTerpilih([]),
    punya: (id: string) => terpilih.includes(id),
    ubah: (id: string, aktif: boolean) =>
      setTerpilih((lama) => (aktif ? [...new Set([...lama, id])] : lama.filter((x) => x !== id))),
    setSemua: (ids: readonly string[]) => setTerpilih(ids),
  };
}

// ---------------------------------------------------------------------------
// The write path, shared by the three input forms
// ---------------------------------------------------------------------------

export interface KirimJurnal {
  status: "diam" | "mengirim" | "selesai" | "gagal";
  /** The document the server created, or null. */
  hasil: Jurnal | null;
  /** The server's own sentence, whatever kind of refusal it was. */
  error: string | null;
  /** Per FIELD detail of a boundary validation, keyed by the router's path. */
  galat: Record<string, string[]> | null;
  /** The engine's own refusal code, for the four that belong on a control. */
  kode: string | null;
  kirim: (input: InputJurnalManual) => Promise<Jurnal | null>;
  reset: () => void;
}

/**
 * Filing a manual journal, once, for all three forms.
 *
 * IT SEPARATES THE THREE KINDS OF REFUSAL the API actually sends, because a
 * form that flattens them into one banner throws away the half an operator can
 * act on:
 *
 *   `galat`  the boundary's per-FIELD detail (`code: "VALIDASI"`), keyed by the
 *            router's own field path. It goes ON the field.
 *   `kode`   the engine's `kodeDomain`. `FIELD_UNTUK_KODE` routes four of them
 *            to a specific control; the rest are shown in the form's error row,
 *            which is the right place for "that period is closed" and "debit
 *            does not equal credit".
 *   `error`  the server's own sentence, always, whatever else was carried.
 *
 * It is its own hook rather than `useAction` for exactly that reason: the
 * shared hook keeps the MESSAGE and drops the body, and the body is where the
 * field paths and the domain code are.
 *
 * NOTHING HERE RETRIES and nothing here is optimistic. If the request did not
 * land, the document does not exist, and drawing the screen as though it did
 * would be a lie the operator acts on.
 */
export function useKirimJurnal(): KirimJurnal {
  const [status, setStatus] = useState<KirimJurnal["status"]>("diam");
  const [hasil, setHasil] = useState<Jurnal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [galat, setGalat] = useState<Record<string, string[]> | null>(null);
  const [kode, setKode] = useState<string | null>(null);

  async function kirim(input: InputJurnalManual): Promise<Jurnal | null> {
    setStatus("mengirim");
    setError(null);
    setGalat(null);
    setKode(null);
    try {
      const jurnal = await buatJurnal(input);
      setHasil(jurnal);
      setStatus("selesai");
      return jurnal;
    } catch (cause: unknown) {
      setHasil(null);
      setError(pesanKesalahan(cause));
      setGalat(galatField(cause));
      setKode(kodeDomain(cause));
      setStatus("gagal");
      return null;
    }
  }

  function reset() {
    setStatus("diam");
    setHasil(null);
    setError(null);
    setGalat(null);
    setKode(null);
  }

  return { status, hasil, error, galat, kode, kirim, reset };
}

/**
 * The sentence for a domain refusal that belongs on a specific control, or
 * undefined. See `FIELD_UNTUK_KODE`.
 */
export function pesanUntukKontrol(
  kode: string | null,
  error: string | null,
  kontrol: string,
): string | undefined {
  if (kode === null || error === null) return undefined;
  return FIELD_UNTUK_KODE[kode] === kontrol ? error : undefined;
}

/** The header fields every manual journal carries, in one shape. */
export function BagianDokumen({
  cabangId,
  setCabangId,
  tanggal,
  setTanggal,
  keterangan,
  setKeterangan,
  galat,
}: {
  cabangId: string;
  setCabangId: (value: string) => void;
  tanggal: string;
  setTanggal: (value: string) => void;
  keterangan: string;
  setKeterangan: (value: string) => void;
  galat: Record<string, string[]> | null;
}) {
  const session = useActiveSession();
  return (
    <Bagian
      title="Data dokumen"
      description="Cabang dan tanggal transaksi menentukan periode akuntansi dokumen ini. Periode dibaca server dari tanggal, bukan dikirim dari halaman ini."
    >
      <FieldGrid>
        <Field
          label="Cabang"
          htmlFor="jurnal-cabang"
          required
          error={pesanUntukField(galat, "cabangId")}
          hint="Hanya cabang dalam wewenang sesi Anda. Cabang di luar itu ditolak server."
        >
          <Select
            id="jurnal-cabang"
            value={cabangId}
            onChange={(event) => setCabangId(event.currentTarget.value)}
            options={session.cabangTersedia.map((cabang) => ({
              value: cabang.id,
              label: `${cabang.kode} ${cabang.nama}`,
            }))}
          />
        </Field>
        <Field
          label="Tanggal transaksi"
          htmlFor="jurnal-tanggal"
          required
          error={pesanUntukField(galat, "tanggalTransaksi")}
          hint="Tanggal peristiwa yang dicatat. Tanggal pada periode tertutup ditolak server."
        >
          <TextInput
            id="jurnal-tanggal"
            type="date"
            value={tanggal}
            onChange={(event) => setTanggal(event.currentTarget.value)}
          />
        </Field>
      </FieldGrid>
      <Field
        label="Keterangan dokumen"
        htmlFor="jurnal-keterangan"
        error={pesanUntukField(galat, "keterangan")}
        hint="Satu kalimat yang menjelaskan dokumen ini kepada orang yang membacanya bulan depan."
      >
        <Textarea
          id="jurnal-keterangan"
          rows={2}
          maxLength={1000}
          value={keterangan}
          onChange={(event) => setKeterangan(event.currentTarget.value)}
        />
      </Field>
    </Bagian>
  );
}

/**
 * What was saved, said plainly: it is a DRAFT, it is not in the ledger, and
 * these are the two people who still have to touch it.
 *
 * A form that answered "berhasil disimpan" and nothing else would let a Maker
 * walk away believing the entry is booked, which is the one misunderstanding
 * spec 6.3's whole maker/checker/approver split exists to prevent.
 */
export function HasilDraft({ jurnal, onLagi }: { jurnal: Jurnal; onLagi: () => void }) {
  return (
    <Panel
      as="h2"
      title={`Draft ${jurnal.noJurnal} tersimpan`}
      description="Dokumen ini berstatus DRAFT dan belum masuk buku besar."
      aside={<BadgeJurnal status={jurnal.status} verifiedAt={jurnal.verifiedAt} />}
      footer={
        <span className="panel-foot-note">
          Sumber: POST /api/jurnal. Nomor dokumen dialokasikan server per jenis dan periode.
        </span>
      }
    >
      <dl className="fakta-grid">
        <div className="fakta-item">
          <dt className="fakta-key">Nomor jurnal</dt>
          <dd className="fakta-val">{jurnal.noJurnal}</dd>
        </div>
        <div className="fakta-item">
          <dt className="fakta-key">Tanggal transaksi</dt>
          <dd className="fakta-val">{formatDate(jurnal.tanggalTransaksi)}</dd>
        </div>
        <div className="fakta-item">
          <dt className="fakta-key">Total debit</dt>
          <dd className="fakta-val">{formatMoney(jurnal.totalDebit)}</dd>
        </div>
        <div className="fakta-item">
          <dt className="fakta-key">Total kredit</dt>
          <dd className="fakta-val">{formatMoney(jurnal.totalKredit)}</dd>
        </div>
      </dl>
      <ol className="langkah-list">
        <li>Checker membuka Verifikasi Jurnal dan memverifikasi draft ini. Anda sendiri ditolak server bila mencoba memverifikasi dokumen yang Anda buat.</li>
        <li>Approver membuka Posting Jurnal dan memposting draft ini ke buku besar.</li>
        <li>Setelah POSTED, dokumen tidak bisa diubah maupun dihapus. Koreksinya adalah jurnal pembalik.</li>
      </ol>
      <div className="form-actions-row">
        <Link className="tautan-dokumen" to={`/jurnal?dokumen=${encodeURIComponent(jurnal.id)}`}>
          Buka dokumen di Daftar Jurnal
        </Link>
        <Button variant="primary" onClick={onLagi}>
          Input dokumen berikutnya
        </Button>
      </div>
    </Panel>
  );
}

/** The form's own complaint list, above the submit row. Never a server rule. */
export function KeluhanForm({ keluhan }: { keluhan: readonly string[] }) {
  if (keluhan.length === 0) {
    return (
      <p className="periksa-ok">
        <Icon name="check" size={16} />
        <span>Bentuk dokumen sudah lengkap dan seimbang. Server memvalidasi ulang saat disimpan.</span>
      </p>
    );
  }
  return (
    <ul className="periksa-list">
      {keluhan.map((teks) => (
        <li className="periksa-item" key={teks}>
          <Icon name="alert" size={16} />
          <span>{teks}</span>
        </li>
      ))}
    </ul>
  );
}

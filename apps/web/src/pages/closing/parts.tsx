// Pieces the three closing screens are built from, so the period picker, the
// branch scope control, the checklist item and the policy card cannot drift
// into three slightly different opinions about the same month.
//
// FOUR RULES LIVE HERE, ONCE EACH.
//
//   THE PERIOD IS IN THE QUERY STRING. A closing conversation is "look at
//   August", and it is had over a pasted link, so the month a screen is showing
//   survives a refresh and travels to a colleague. Nothing about the period is
//   held in component state.
//
//   THE BRANCH IS A NARROWING FILTER, NEVER AUTHORITY. `Semua cabang` is
//   offered only when `referensi.bolehSemuaCabang` says the session's scope
//   covers the whole entity, because offering it to a branch user offers a run
//   the engine refuses. Picking one branch sends `cabangId`; picking Semua
//   sends no key at all, which is spec 8.1's "every branch at once" and is a
//   different request from `cabangId: null`.
//
//   A CHECK SHOWS ITS FIGURE, NOT JUST ITS COLOUR. Spec 8.4 gives every
//   prerequisite a readable Indonesian `alasan` and a `detail` carrying the
//   offending rows, and this file renders BOTH: the sentence, the count behind
//   it, and the list of journals or akad that caused it. A checklist that only
//   goes red leaves an Approver with a blocked close and nowhere to look, which
//   is the exact failure spec 16 scenario 12 names.
//
//   MONEY GOES THROUGH packages/ui. Not one figure below is formatted by hand:
//   `formatMoney` renders an unreadable value as a visible marker rather than
//   as a silent zero, and a closing screen is the last place a wrong number
//   should be able to look like a right one.
import { useMemo, type ReactNode } from "react";
import {
  Button,
  DataList,
  Icon,
  Panel,
  Select,
  StatusBadge,
  formatCount,
  formatDate,
  formatMoney,
  formatPeriode,
  formatRate,
  jumlahkanUang,
  UNPARSEABLE,
  type BadgeTone,
} from "@krakatausteel/ui";
import {
  daftarPeriodeClosing,
  referensiClosing,
  type BarisKolektibilitas,
  type DasarPerhitunganPenyisihan,
  type HasilPrasyarat,
  type KelasKolektibilitas,
  type KodePrasyarat,
  type ModePenyisihan,
  type OpsiPeriodeClosing,
  type RingkasanKelas,
  type SelKematriks,
  type StatusPrasyarat,
  type Uang,
} from "../../api/closing";
import { useApi, type HasilApi } from "../../api/useApi";
import { Link, useRouter } from "../../router";

// ---------------------------------------------------------------------------
// The month
// ---------------------------------------------------------------------------

export const SEMUA_CABANG = "SEMUA";

export interface KonteksClosing {
  referensi: HasilApi<Awaited<ReturnType<typeof referensiClosing>>>;
  daftar: HasilApi<{ data: OpsiPeriodeClosing[] }>;
  periodeId: string | null;
  periode: OpsiPeriodeClosing | null;
  daftarPeriode: readonly OpsiPeriodeClosing[];
  /** Null means every branch in scope, which is NOT the same as no branch. */
  cabangId: string | null;
  namaCabang: string;
  /** The period and branch selects, laid out as one row. */
  kontrol: ReactNode;
  /** One line naming what is selected, for the phone filter sheet. */
  ringkas: string;
  siap: boolean;
}

/**
 * Period and branch, read from the query string, defaulting to the newest month
 * the entity has. Both closing screens open on this, and the Periode Akuntansi
 * screen reuses the same list so the three cannot disagree about which months
 * exist.
 */
export function useKonteksClosing(): KonteksClosing {
  const { query, setQuery } = useRouter();
  const referensi = useApi(() => referensiClosing(), []);
  const daftar = useApi(() => daftarPeriodeClosing(), []);

  const daftarPeriode = daftar.data?.data ?? [];
  const periodeUrl = query.get("periode");
  const periodeId =
    periodeUrl && daftarPeriode.some((p) => p.id === periodeUrl)
      ? periodeUrl
      : (daftarPeriode[0]?.id ?? null);
  const periode = daftarPeriode.find((p) => p.id === periodeId) ?? null;

  const opsiCabang = referensi.data?.cabang ?? [];
  const bolehSemua = referensi.data?.bolehSemuaCabang ?? false;
  const cabangUrl = query.get("cabang");
  const lingkup =
    cabangUrl === SEMUA_CABANG && bolehSemua
      ? SEMUA_CABANG
      : cabangUrl && opsiCabang.some((c) => c.id === cabangUrl)
        ? cabangUrl
        : bolehSemua
          ? SEMUA_CABANG
          : (opsiCabang[0]?.id ?? null);
  const cabangId = lingkup === SEMUA_CABANG ? null : lingkup;
  const namaCabang =
    lingkup === SEMUA_CABANG
      ? "Seluruh cabang dalam wewenang Anda"
      : (opsiCabang.find((c) => c.id === lingkup)?.nama ?? "Cabang belum dipilih");

  const kontrol = (
    <div className="filter-laporan">
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Periode akuntansi</span>
        <Select
          aria-label="Periode akuntansi"
          value={periodeId ?? ""}
          disabled={daftarPeriode.length === 0}
          onChange={(event) => setQuery("periode", event.currentTarget.value)}
          options={
            daftarPeriode.length === 0
              ? [
                  {
                    value: "",
                    label: daftar.status === "memuat" ? "Memuat periode" : "Tidak ada periode",
                  },
                ]
              : daftarPeriode.map((p) => ({
                  value: p.id,
                  label: `${formatPeriode(p.tahun, p.bulan)}, ${LABEL_STATUS_PERIODE[p.status] ?? p.status}`,
                }))
          }
        />
      </label>
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Lingkup cabang</span>
        <Select
          aria-label="Lingkup cabang"
          value={lingkup ?? ""}
          disabled={opsiCabang.length === 0 && !bolehSemua}
          onChange={(event) => setQuery("cabang", event.currentTarget.value)}
          options={[
            ...(bolehSemua
              ? [{ value: SEMUA_CABANG, label: "Semua cabang dalam wewenang" }]
              : []),
            ...opsiCabang.map((c) => ({ value: c.id, label: `${c.kode} ${c.nama}` })),
            ...(opsiCabang.length === 0 && !bolehSemua
              ? [
                  {
                    value: "",
                    label: referensi.status === "memuat" ? "Memuat cabang" : "Tidak ada cabang",
                  },
                ]
              : []),
          ]}
        />
      </label>
    </div>
  );

  return {
    referensi,
    daftar,
    periodeId,
    periode,
    daftarPeriode,
    cabangId,
    namaCabang,
    kontrol,
    ringkas: `${periode ? formatPeriode(periode.tahun, periode.bulan) : "Periode belum dipilih"}, ${namaCabang}`,
    siap: referensi.status === "siap" && daftar.status === "siap" && periodeId !== null,
  };
}

export const LABEL_STATUS_PERIODE: Record<string, string> = {
  OPEN: "Terbuka",
  CLOSING_IN_PROGRESS: "Proses closing",
  CLOSED: "Tertutup",
};

/** "Agustus 2026", or an honest blank when no month is selected yet. */
export function labelPeriode(periode: OpsiPeriodeClosing | null): string {
  return periode ? formatPeriode(periode.tahun, periode.bulan) : "periode yang dipilih";
}

// ---------------------------------------------------------------------------
// Accounting policy, as the screen is allowed to state it
// ---------------------------------------------------------------------------

export const LABEL_MODE_PENYISIHAN: Record<ModePenyisihan, string> = {
  RATE_TABLE: "Tabel rate per kolektibilitas",
  KOLEKTIF_HISTORIS: "Kolektif historis",
};

export const LABEL_DASAR_PENYISIHAN: Record<DasarPerhitunganPenyisihan, string> = {
  OUTSTANDING_POKOK: "Outstanding pokok",
  OUTSTANDING_POKOK_PLUS_JASA: "Outstanding pokok ditambah jasa",
};

export const LABEL_SUMBER_RATE: Record<string, string> = {
  TABEL_KONFIGURASI: "Tabel konfigurasi penyisihan",
  KOLEKTIF_HISTORIS: "Perhitungan kolektif historis",
};

export const LABEL_METODE_JASA: Record<string, string> = {
  CASH_BASIS: "Cash basis",
  ACCRUAL: "Akrual",
};

export const LABEL_KELAS: Record<KelasKolektibilitas, string> = {
  LANCAR: "Lancar",
  KURANG_LANCAR: "Kurang Lancar",
  DIRAGUKAN: "Diragukan",
  MACET: "Macet",
};

export const URUTAN_KELAS: readonly KelasKolektibilitas[] = [
  "LANCAR",
  "KURANG_LANCAR",
  "DIRAGUKAN",
  "MACET",
];

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

const POLA_UANG = /^-?\d+(\.\d{1,2})?$/;

/**
 * One `Uang` on a closing screen. Zero prints "0,00" because an accounting
 * figure is never blank, and a value that is not a figure prints the marker
 * `packages/ui` uses everywhere else rather than a zero nobody could question.
 */
export function NilaiUang({ nilai }: { nilai: Uang | null | undefined }) {
  if (typeof nilai !== "string" || !POLA_UANG.test(nilai)) {
    return (
      <span className="cell-invalid" title={`Nilai tidak dapat dibaca: ${String(nilai)}`}>
        {UNPARSEABLE}
      </span>
    );
  }
  return <span className="angka">{formatMoney(nilai, { parenthesizeNegative: true })}</span>;
}

/** The same as plain text, for a table cell rendered through DataTable. */
export function teksUang(nilai: Uang | null | undefined): string {
  if (typeof nilai !== "string" || !POLA_UANG.test(nilai)) return UNPARSEABLE;
  return formatMoney(nilai, { parenthesizeNegative: true });
}

/**
 * The distribution, derived from the snapshot rows when the server did not send
 * a summary with them.
 *
 * `GET .../kolektibilitas/snapshot` answers with the stored rows and nothing
 * else, so a viewer holding only `admin.closing.view` would otherwise see no
 * distribution at all. The grouping is a plain group by class and every total
 * goes through `jumlahkanUang`, which adds in integer cents and returns null
 * when any input is unreadable, so a total that quietly dropped a row is not a
 * shape this can produce. A preview or a committed run carries the server's own
 * `ringkasanPerKelas` and that one is used instead, never both.
 */
export function ringkasDariBaris(baris: readonly BarisKolektibilitas[]): RingkasanKelas[] {
  return URUTAN_KELAS.map((kelas) => {
    const anggota = baris.filter((row) => row.kolektibilitas === kelas);
    const pokok = jumlahkanUang(anggota.map((row) => row.outstandingPokok));
    const penyisihan = jumlahkanUang(anggota.map((row) => row.nilaiPenyisihan));
    return {
      kelas,
      jumlahAkad: anggota.length,
      // null is not zero: an unreadable member makes the whole total
      // unknowable, and the marker is what must appear on screen.
      outstandingPokok: (pokok ?? UNPARSEABLE) as Uang,
      nilaiPenyisihan: (penyisihan ?? UNPARSEABLE) as Uang,
    };
  }).filter((row) => row.jumlahAkad > 0);
}

/** The migration matrix, derived from the snapshot the same way and for the
 *  same reason. `dari` is null for an akad with no previous snapshot. */
export function matriksDariBaris(baris: readonly BarisKolektibilitas[]): SelKematriks[] {
  const peta = new Map<string, SelKematriks>();
  for (const row of baris) {
    const kunci = `${row.kolektibilitasPeriodeLalu ?? ""}>${row.kolektibilitas}`;
    const ada = peta.get(kunci);
    if (ada) {
      peta.set(kunci, {
        ...ada,
        jumlahAkad: ada.jumlahAkad + 1,
        outstandingPokok: (jumlahkanUang([ada.outstandingPokok, row.outstandingPokok]) ??
          UNPARSEABLE) as Uang,
      });
      continue;
    }
    peta.set(kunci, {
      dari: row.kolektibilitasPeriodeLalu,
      ke: row.kolektibilitas,
      jumlahAkad: 1,
      outstandingPokok: row.outstandingPokok,
    });
  }
  return [...peta.values()];
}

/**
 * The rate and the basis that ACTUALLY produced each class, read off the stored
 * rows (migrations 0024 and 0025). Distinct rows for one class mean the policy
 * changed mid run, which is exactly the thing the provenance columns exist to
 * make visible, so they are listed rather than collapsed.
 */
export interface AsalRate {
  kelas: KelasKolektibilitas;
  rate: string;
  dasarPerhitungan: DasarPerhitunganPenyisihan;
  sumberRate: string;
  jumlahAkad: number;
}

export function asalRateDariBaris(baris: readonly BarisKolektibilitas[]): AsalRate[] {
  const peta = new Map<string, AsalRate>();
  for (const row of baris) {
    const kunci = `${row.kolektibilitas}|${row.ratePenyisihan}|${row.dasarPerhitungan}|${row.sumberRate}`;
    const ada = peta.get(kunci);
    peta.set(
      kunci,
      ada
        ? { ...ada, jumlahAkad: ada.jumlahAkad + 1 }
        : {
            kelas: row.kolektibilitas,
            rate: row.ratePenyisihan,
            dasarPerhitungan: row.dasarPerhitungan,
            sumberRate: row.sumberRate,
            jumlahAkad: 1,
          },
    );
  }
  return [...peta.values()].sort(
    (a, b) => URUTAN_KELAS.indexOf(a.kelas) - URUTAN_KELAS.indexOf(b.kelas),
  );
}

/**
 * A rate as a percentage. Guarded before `formatRate` rather than after it,
 * because `formatMoney` THROWS on an unreadable value outside production, and a
 * rate that arrived malformed must show the marker on the screen rather than
 * take the whole panel down with it.
 */
export function teksRate(rate: string | null | undefined): string {
  if (typeof rate !== "string" || !/^-?\d+(\.\d+)?$/.test(rate.trim())) return UNPARSEABLE;
  const tampil = formatRate(rate);
  return tampil === "" || tampil === UNPARSEABLE ? UNPARSEABLE : `${tampil}%`;
}

// ---------------------------------------------------------------------------
// The ten prerequisites
// ---------------------------------------------------------------------------

/** The short title of each check, in spec 8.4's own order and wording. */
export const JUDUL_PRASYARAT: Record<KodePrasyarat, string> = {
  PERIODE_SEBELUMNYA_BELUM_CLOSED: "Periode sebelumnya sudah ditutup",
  ADA_JURNAL_DRAFT: "Tidak ada jurnal berstatus draft",
  JURNAL_TIDAK_BALANCE: "Setiap jurnal seimbang debit dan kredit",
  KOLEKTIBILITAS_BELUM_DIJALANKAN: "Closing kolektibilitas sudah dijalankan",
  PENYISIHAN_BELUM_POSTED: "Penyisihan sudah dihitung atau dinyatakan nol",
  AKRUAL_BELUM_POSTED: "Akrual jasa administrasi sudah dijalankan",
  NERACA_LAJUR_TIDAK_BALANCE: "Neraca lajur seimbang",
  SALDO_KAS_NEGATIF: "Saldo kas dan setara kas tidak negatif",
  OUTSTANDING_POKOK_NEGATIF: "Tidak ada akad dengan sisa pokok negatif",
  SUB_LEDGER_TIDAK_COCOK: "Kartu piutang cocok dengan buku besar",
};

const NADA_PRASYARAT: Record<StatusPrasyarat, BadgeTone> = {
  PASS: "success",
  GAGAL: "danger",
  PERINGATAN: "caution",
};

const LABEL_PRASYARAT: Record<StatusPrasyarat, string> = {
  PASS: "Lolos",
  GAGAL: "Gagal",
  PERINGATAN: "Perlu konfirmasi",
};

function daftarDetail(nilai: unknown): Record<string, unknown>[] {
  return Array.isArray(nilai)
    ? nilai.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    : [];
}

function teks(nilai: unknown): string {
  return typeof nilai === "string" ? nilai : "";
}

/**
 * The figure behind a check, named.
 *
 * Every one of these reads a field the engine already puts in `detail`; not one
 * is computed here. A check without a countable figure says so in words rather
 * than printing a zero that would read as "nothing is wrong".
 */
export function angkaPrasyarat(hasil: HasilPrasyarat): { label: string; nilai: string } {
  const d = hasil.detail;
  switch (hasil.kode) {
    case "PERIODE_SEBELUMNYA_BELUM_CLOSED":
      return { label: "Periode belum ditutup", nilai: formatCount(daftarDetail(d.periode).length) };
    case "ADA_JURNAL_DRAFT":
      return { label: "Jurnal berstatus draft", nilai: formatCount(daftarDetail(d.jurnal).length) };
    case "JURNAL_TIDAK_BALANCE":
      return { label: "Jurnal tidak seimbang", nilai: formatCount(daftarDetail(d.jurnal).length) };
    case "KOLEKTIBILITAS_BELUM_DIJALANKAN":
      return { label: "Run tersimpan", nilai: d.adaRun === true ? "Ada" : "Belum ada" };
    case "PENYISIHAN_BELUM_POSTED":
      return { label: "Cabang sudah dihitung", nilai: formatCount(daftarDetail(d.cabang).length) };
    case "AKRUAL_BELUM_POSTED":
      return {
        label: "Baris akrual tersimpan",
        nilai:
          typeof d.jumlahBaris === "number"
            ? formatCount(d.jumlahBaris)
            : teks(d.metode) === ""
              ? "Tidak tersedia"
              : `Metode ${LABEL_METODE_JASA[teks(d.metode)] ?? teks(d.metode)}`,
      };
    case "NERACA_LAJUR_TIDAK_BALANCE":
      // ABSENT AND UNREADABLE ARE TWO DIFFERENT THINGS. A figure that arrived
      // malformed must show the marker, but a `detail` that simply carries no
      // `selisih` is a check that sent no number, and printing the marker there
      // would put "tidak sah" on a check that passed.
      return {
        label: "Selisih debit dan kredit",
        nilai: teks(d.selisih) === "" ? "Tidak tersedia" : teksUang(teks(d.selisih)),
      };
    case "SALDO_KAS_NEGATIF":
      return { label: "Akun kas bersaldo negatif", nilai: formatCount(daftarDetail(d.akun).length) };
    case "OUTSTANDING_POKOK_NEGATIF":
      return { label: "Akad bersisa pokok negatif", nilai: formatCount(daftarDetail(d.akad).length) };
    case "SUB_LEDGER_TIDAK_COCOK":
      return { label: "Akad yang selisih", nilai: formatCount(daftarDetail(d.akad).length) };
    default:
      return { label: "Rincian", nilai: "Tidak ada angka" };
  }
}

/**
 * The rows that caused a failure, as an operator would name them: journal
 * numbers, akad numbers, account names, months. Spec 8.4 requires check 10 in
 * particular to carry the offending akad list, because "tidak cocok" alone
 * leaves a close blocked with nowhere to look.
 */
export function rincianPrasyarat(hasil: HasilPrasyarat): string[] {
  const d = hasil.detail;
  switch (hasil.kode) {
    case "PERIODE_SEBELUMNYA_BELUM_CLOSED":
      return daftarDetail(d.periode).map((p) =>
        typeof p.tahun === "number" && typeof p.bulan === "number"
          ? formatPeriode(p.tahun, p.bulan)
          : teks(p.id),
      );
    case "ADA_JURNAL_DRAFT":
      return daftarDetail(d.jurnal).map((j) => teks(j.noJurnal));
    case "JURNAL_TIDAK_BALANCE":
      return daftarDetail(d.jurnal).map(
        (j) => `${teks(j.noJurnal)}, selisih ${teksUang(teks(j.selisih))}`,
      );
    case "SALDO_KAS_NEGATIF":
      return daftarDetail(d.akun).map(
        (a) => `${teks(a.kode)} ${teks(a.nama)}, saldo ${teksUang(teks(a.saldo))}`,
      );
    case "OUTSTANDING_POKOK_NEGATIF":
      return daftarDetail(d.akad).map((a) => teks(a.noAkad));
    case "SUB_LEDGER_TIDAK_COCOK":
      return daftarDetail(d.akad).map(
        (a) =>
          `${teks(a.noAkad)}, kartu piutang ${teksUang(teks(a.saldoSubLedger))} lawan buku besar ${teksUang(
            teks(a.saldoBukuBesar),
          )}, selisih ${teksUang(teks(a.selisih))}`,
      );
    default:
      return [];
  }
}

/**
 * One prerequisite, whole: its number, its title, its state, the sentence the
 * engine wrote, the figure behind it, and the rows that caused it.
 *
 * Every item has the SAME internal shape whatever its state, so ten of them
 * read as one list rather than as a pile of differently sized boxes: title row,
 * sentence, figure, and a drill-down that is present only when there are rows
 * to name.
 */
export function ItemPrasyarat({ hasil }: { hasil: HasilPrasyarat }) {
  const angka = angkaPrasyarat(hasil);
  const rincian = rincianPrasyarat(hasil);
  return (
    <li className={`prasyarat-item is-${hasil.status.toLowerCase()}`}>
      <div className="prasyarat-head">
        <span className="prasyarat-nomor" aria-hidden="true">
          {hasil.nomor}
        </span>
        <span className="prasyarat-judul">{JUDUL_PRASYARAT[hasil.kode] ?? hasil.kode}</span>
        <StatusBadge
          status={hasil.status}
          tone={NADA_PRASYARAT[hasil.status]}
          label={LABEL_PRASYARAT[hasil.status]}
        />
      </div>
      <p className="prasyarat-alasan">{hasil.alasan}</p>
      <div className="prasyarat-foot">
        <span className="prasyarat-angka-label">{angka.label}</span>
        <span className="prasyarat-angka-val">{angka.nilai}</span>
      </div>
      {rincian.length === 0 ? null : (
        <ul className="prasyarat-rincian">
          {rincian.slice(0, 20).map((baris) => (
            <li className="prasyarat-rincian-item" key={baris}>
              {baris}
            </li>
          ))}
          {rincian.length > 20 ? (
            <li className="prasyarat-rincian-item">
              dan {formatCount(rincian.length - 20)} baris lain
            </li>
          ) : null}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Small shared cards
// ---------------------------------------------------------------------------

/**
 * The accounting policies in force, read from `konfigurasi` by the server. On
 * the screen because they decide what the closing steps will DO: under CASH
 * BASIS the accrual step legitimately produces nothing, and an operator told
 * that after the click reads it as a failure.
 */
export function KartuKebijakan({
  kapabilitas,
}: {
  kapabilitas: {
    modePenyisihan: ModePenyisihan;
    dasarPerhitunganPenyisihan: DasarPerhitunganPenyisihan;
    metodePengakuanJasa: string;
    kelasDiakrual: readonly KelasKolektibilitas[];
    izinkanReopen: boolean;
    izinkanSaldoKasNegatif: boolean;
  };
}) {
  return (
    <DataList
      items={[
        {
          label: "Mode penyisihan",
          value: LABEL_MODE_PENYISIHAN[kapabilitas.modePenyisihan] ?? kapabilitas.modePenyisihan,
        },
        {
          label: "Dasar perhitungan",
          value:
            LABEL_DASAR_PENYISIHAN[kapabilitas.dasarPerhitunganPenyisihan] ??
            kapabilitas.dasarPerhitunganPenyisihan,
        },
        {
          label: "Pengakuan jasa administrasi",
          value:
            LABEL_METODE_JASA[kapabilitas.metodePengakuanJasa] ?? kapabilitas.metodePengakuanJasa,
        },
        {
          label: "Kelas yang diakru",
          value:
            kapabilitas.kelasDiakrual.length === 0
              ? "Tidak ada kelas yang diakru"
              : kapabilitas.kelasDiakrual.map((k) => LABEL_KELAS[k] ?? k).join(", "),
        },
        {
          label: "Saldo kas negatif",
          value: kapabilitas.izinkanSaldoKasNegatif ? "Diizinkan" : "Tidak diizinkan",
        },
        {
          label: "Reopen periode",
          value: kapabilitas.izinkanReopen ? "Diizinkan konfigurasi" : "Dimatikan konfigurasi",
        },
      ]}
    />
  );
}

/** A link to the journal an entry produced. The journal pages land in their own
 *  phase, so the link stops at the journal list with the entry id carried. */
export function TautanJurnal({ jurnalId }: { jurnalId: string | null }) {
  if (jurnalId === null) {
    return <span className="angka-kosong">Belum ada jurnal</span>;
  }
  return (
    <Link className="tautan-dokumen" to={`/jurnal?jurnal=${encodeURIComponent(jurnalId)}`}>
      Buka jurnal
    </Link>
  );
}

/**
 * The notice a screen shows in place of a control the caller may not use.
 *
 * Hiding a control is a convenience, never a control: the server checks every
 * one of these codes again and writes a DITOLAK audit row when it refuses. This
 * says WHICH authority is missing, so a reader knows what to ask for instead of
 * concluding the feature does not exist.
 */
export function TanpaWewenang({ judul, children }: { judul: string; children: ReactNode }) {
  return (
    <div className="peringatan" role="note">
      <Icon name="lock" size={18} />
      <div>
        <p className="peringatan-judul">{judul}</p>
        <p className="peringatan-teks">{children}</p>
      </div>
    </div>
  );
}

/** A run that produced nothing, said as a policy outcome and not as a failure. */
export function HasilKosong({ judul, teks: isi }: { judul: string; teks: string }) {
  return (
    <div className="antrean-kosong">
      <span className="antrean-kosong-icon" aria-hidden="true">
        <Icon name="history" size={20} />
      </span>
      <p className="antrean-kosong-title">{judul}</p>
      <p className="antrean-kosong-desc">{isi}</p>
    </div>
  );
}

/** The action row every closing panel puts at its foot, at one rhythm. */
export function BarisJalankan({
  error,
  children,
}: {
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="closing-aksi">
      {error ? (
        <p className="form-error" role="alert">
          <Icon name="alert" size={16} />
          <span>{error}</span>
        </p>
      ) : null}
      <div className="closing-aksi-row">{children}</div>
    </div>
  );
}

/**
 * A panel that names the endpoint it was read from, the way every report on
 * this product does. A figure whose source cannot be named is a figure nobody
 * can check.
 */
export function PanelSumber({
  title,
  description,
  sumber,
  aside,
  children,
}: {
  title: string;
  description?: string;
  sumber: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Panel
      as="h2"
      title={title}
      description={description}
      aside={aside}
      footer={<span className="panel-foot-note">Sumber: {sumber}</span>}
    >
      {children}
    </Panel>
  );
}

/** Who closed a month and when, as facts rather than as ids. */
export function useFaktaPeriode(periode: OpsiPeriodeClosing | null) {
  return useMemo(() => {
    if (!periode) return [];
    return [
      { label: "Periode", value: formatPeriode(periode.tahun, periode.bulan) },
      { label: "Status", value: <StatusBadge status={periode.status} /> },
      {
        label: "Rentang tanggal",
        value: `${formatDate(periode.tanggalMulai)} sampai ${formatDate(periode.tanggalAkhir)}`,
      },
      { label: "Ditutup oleh", value: periode.closedOleh ?? "Belum ditutup" },
      {
        label: "Waktu penutupan",
        value: periode.closedAt ? formatDate(periode.closedAt) : "Belum ditutup",
      },
      {
        label: "Dibuka kembali oleh",
        value: periode.dibukaKembaliOleh ?? "Belum pernah dibuka kembali",
      },
      {
        label: "Waktu dibuka kembali",
        value: periode.reopenedAt ? formatDate(periode.reopenedAt) : "Belum pernah dibuka kembali",
      },
      {
        label: "Alasan dibuka kembali",
        value: periode.alasanReopen ?? "Tidak ada",
        wide: true,
      },
      {
        label: "Baris saldo beku",
        value: formatCount(periode.jumlahSaldoBeku),
        numeric: true,
      },
      {
        label: "Template laporan tercap",
        value: periode.templateLaporanId
          ? "Ada, laporan periode ini dicetak dengan template itu"
          : "Belum ada cap template",
      },
    ];
  }, [periode]);
}

/** A plain refresh control, identical on every closing panel that has one. */
export function TombolMuatUlang({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} leading={<Icon name="refresh" size={16} />}>
      Muat ulang
    </Button>
  );
}

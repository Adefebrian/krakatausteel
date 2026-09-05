// THE TWO REPORTS WHOSE WINDOW IS NOT A PERIODE: 5. Laporan Jatuh Tempo and
// 31. Laporan Audit Trail.
//
// Every other report in spec 10 is asked for a month. These two are asked for a
// date range, and that is not a cosmetic difference: report 5 looks FORWARD
// ("rentang tanggal jatuh tempo ke depan") and report 31 looks BACKWARD over an
// unbounded log. Giving either of them the period picker would have meant
// pretending a month is the question they answer.
//
// They share this file because they share their parameter, and they share the
// report BODY with the eighteen declared reports in ./operasional.tsx: the
// header, the table with its footing, the totals panel and the failure state
// all come from ./generik.tsx. Only the parameters and the paging are local.
import { useMemo, type ReactNode } from "react";
import {
  Button,
  Icon,
  Panel,
  Select,
  StatusBadge,
  formatCount,
  formatDate,
} from "@krakatausteel/ui";
import {
  auditTrail,
  jatuhTempo,
  type BarisAuditTrail,
  type BarisJatuhTempo,
  type HasilAudit,
  type LaporanAuditTrail,
  type LaporanJatuhTempo,
} from "../../api/laporan-operasional";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useRouter } from "../../router";
import { hariIni } from "../shared/parts";
import {
  IsiLaporan,
  tanggalPlus,
  useRentangTanggal,
  type BadanDeklarasi,
} from "./generik";
import { HalamanLaporan, KopLaporan, Nilai, teksNilai, useFilterLaporan } from "./parts";

// ===========================================================================
// 5. Laporan Jatuh Tempo
// ===========================================================================

/** Ninety days is the window a collections officer plans against. It is a
 *  DEFAULT and not a rule: both dates are controls and both live in the query
 *  string, so a link to a particular window opens on that window. */
const JENDELA_BAWAAN_HARI = 90;

const JATUH_TEMPO: BadanDeklarasi<LaporanJatuhTempo, BarisJatuhTempo> = {
  kelompok: "Laporan Pendanaan UMK",
  judul: "laporan jatuh tempo",
  sumber: "GET /api/laporan/jatuh-tempo",
  perluPeriode: false,
  baris: (d) => d.baris,
  rowKey: (r) => r.jadwalId,
  kolom: (d) => [
    {
      key: "tanggalJatuhTempo",
      header: "Jatuh tempo",
      type: "date",
      width: "140px",
      sortable: true,
      footer: "Total",
    },
    // One identity, one column. See `SelMitra` in ./operasional.tsx: ten
    // columns did not fit a desk, and the column that fell off the edge was
    // always the last one, which on this report is the state of the schedule.
    {
      key: "namaMitra",
      header: "Mitra Binaan",
      width: "200px",
      render: (r) => (
        <span className="sel-nama">
          <span className="sel-nama-judul">{r.namaMitra}</span>
          <span className="sel-nama-sub">{r.kodeMitra}</span>
        </span>
      ),
    },
    { key: "noAkad", header: "No akad", width: "150px" },
    { key: "angsuranKe", header: "Angsuran ke", type: "count", width: "130px" },
    {
      key: "pokok",
      header: "Pokok",
      type: "money",
      width: "160px",
      render: (r) => <Nilai angka={r.pokok} />,
      footer: <Nilai angka={d.total.pokok} />,
    },
    {
      key: "jasaAdm",
      header: "Jasa administrasi",
      type: "money",
      width: "170px",
      render: (r) => <Nilai angka={r.jasaAdm} />,
      footer: <Nilai angka={d.total.jasaAdm} />,
    },
    {
      key: "total",
      header: "Total angsuran",
      type: "money",
      width: "170px",
      render: (r) => <Nilai angka={r.total} />,
      footer: <Nilai angka={d.total.total} />,
    },
    {
      key: "hariSampaiJatuhTempo",
      header: "Hari sampai jatuh tempo",
      type: "count",
      width: "190px",
    },
    {
      key: "status",
      header: "Status jadwal",
      width: "160px",
      render: (r) => <StatusBadge status={r.status} />,
    },
  ],
  kartu: (r) => ({
    judul: `${r.kodeMitra} ${r.namaMitra}`,
    sub: `${r.noAkad}, angsuran ke ${formatCount(r.angsuranKe)}`,
    meta: `Jatuh tempo ${formatDate(r.tanggalJatuhTempo)}, ${formatCount(r.hariSampaiJatuhTempo)} hari lagi`,
    nilai: teksNilai(r.total),
    nilaiLabel: "Total angsuran",
    status: <StatusBadge status={r.status} />,
  }),
  tabel: { judul: "Angsuran yang akan jatuh tempo" },
  kosong: {
    judul: "Tidak ada angsuran jatuh tempo pada rentang ini",
    pesan: "Tidak ada baris jadwal yang jatuh tempo di antara kedua tanggal yang dipilih.",
  },
  total: (d) => [
    { label: "Jumlah angsuran", kunci: "Baris", nilai: formatCount(d.total.jumlahAngsuran) },
    {
      label: "Pokok",
      kunci: "Nilai",
      nilai: <Nilai angka={d.total.pokok} />,
      kedua: { kunci: "Jasa administrasi", nilai: <Nilai angka={d.total.jasaAdm} /> },
    },
    { label: "Total angsuran", kunci: "Nilai", nilai: <Nilai angka={d.total.total} /> },
  ],
  catatan: (d) =>
    `Hari sampai jatuh tempo dihitung terhadap tanggal acuan ${formatDate(d.tanggalAcuan)}, yaitu tanggal server saat laporan ini dibentuk, bukan tanggal awal rentang yang dipilih.`,
};

export function JatuhTempoPage({ route }: { route: PageRoute }) {
  const rentang = useRentangTanggal(
    { dariTanggal: hariIni(), sampaiTanggal: tanggalPlus(JENDELA_BAWAAN_HARI) },
    { dari: "Jatuh tempo dari", sampai: "Jatuh tempo sampai" },
  );

  // Branch only. `perluPeriode: false` is what keeps the period picker off a
  // report whose window is a date range: offering both would invite a reader to
  // believe the month narrowed the range.
  const filter = useFilterLaporan({
    perluPeriode: false,
    tambahan: rentang.kontrol,
    ringkasTambahan: rentang.ringkas,
  });

  const hasil = useApi(
    () =>
      jatuhTempo({
        dariTanggal: rentang.rentang.dariTanggal,
        sampaiTanggal: rentang.rentang.sampaiTanggal,
        cabangId: filter.cabangId,
      }),
    [rentang.rentang.dariTanggal, rentang.rentang.sampaiTanggal, filter.cabangId],
    { enabled: filter.siap && rentang.sah },
  );

  return (
    <IsiLaporan
      route={route}
      crumb="Laporan Pendanaan UMK"
      filter={filter}
      hasil={hasil}
      deklarasi={JATUH_TEMPO}
      diamLabel="Pilih rentang tanggal jatuh tempo yang benar untuk membuka laporan ini."
    />
  );
}

// ===========================================================================
// 31. Laporan Audit Trail
// ===========================================================================

const BATAS_HALAMAN = 100;
const HASIL: readonly { value: string; label: string }[] = [
  { value: "", label: "Semua hasil" },
  { value: "SUKSES", label: "Hanya yang berhasil" },
  { value: "DITOLAK", label: "Hanya yang ditolak" },
];

/**
 * Read only by construction, and paged for the same reason the API pages it: an
 * audit log is unbounded, and a page that asked for all of it would be a denial
 * of service against the reader's own browser.
 *
 * There is no delete control and no edit control on this screen, and there is
 * no endpoint behind one either. Spec 10.4 report 31: "Read only, tidak bisa
 * dihapus siapa pun."
 */
export function AuditTrailPage({ route }: { route: PageRoute }) {
  const { query, setQuery } = useRouter();
  const rentang = useRentangTanggal(
    { dariTanggal: tanggalPlus(-30), sampaiTanggal: hariIni() },
    { dari: "Dari tanggal", sampai: "Sampai tanggal" },
  );

  const entitas = query.get("entitas") ?? "";
  const aksi = query.get("aksi") ?? "";
  const hasilPilihan = query.get("hasil") ?? "";
  const offset = Math.max(0, Number(query.get("offset") ?? "0") || 0);

  const kontrolTambahan = (
    <>
      {rentang.kontrol}
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Entitas</span>
        <input
          type="text"
          className="control"
          aria-label="Entitas audit"
          placeholder="Misalnya pumk_akad"
          value={entitas}
          onChange={(event) => {
            setQuery("offset", null);
            setQuery("entitas", event.currentTarget.value);
          }}
        />
      </label>
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Aksi</span>
        <input
          type="text"
          className="control"
          aria-label="Aksi audit"
          placeholder="Misalnya akad.buat"
          value={aksi}
          onChange={(event) => {
            setQuery("offset", null);
            setQuery("aksi", event.currentTarget.value);
          }}
        />
      </label>
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Hasil</span>
        <Select
          aria-label="Hasil audit"
          value={hasilPilihan}
          onChange={(event) => {
            setQuery("offset", null);
            setQuery("hasil", event.currentTarget.value);
          }}
          options={HASIL}
        />
      </label>
    </>
  );

  const filter = useFilterLaporan({
    perluPeriode: false,
    tambahan: kontrolTambahan,
    ringkasTambahan: rentang.ringkas,
  });

  const hasil = useApi(
    () =>
      auditTrail({
        dariTanggal: rentang.rentang.dariTanggal,
        sampaiTanggal: rentang.rentang.sampaiTanggal,
        entitas: entitas.trim() === "" ? null : entitas.trim(),
        aksi: aksi.trim() === "" ? null : aksi.trim(),
        hasil: hasilPilihan === "" ? null : (hasilPilihan as HasilAudit),
        batas: BATAS_HALAMAN,
        offset,
      }),
    [
      rentang.rentang.dariTanggal,
      rentang.rentang.sampaiTanggal,
      entitas,
      aksi,
      hasilPilihan,
      offset,
    ],
    { enabled: filter.siap && rentang.sah },
  );

  return (
    <HalamanLaporan
      route={route}
      filter={filter}
      hasil={hasil}
      judul="laporan audit trail"
      sumber="GET /api/laporan/audit-trail"
      crumb="Laporan Lainnya"
      diamLabel="Pilih rentang tanggal yang benar untuk membuka laporan ini."
    >
      {(data: LaporanAuditTrail) => (
        <BadanAudit data={data} onOffset={(nilai) => setQuery("offset", nilai === 0 ? null : String(nilai))} />
      )}
    </HalamanLaporan>
  );
}

function BadanAudit({
  data,
  onOffset,
}: {
  data: LaporanAuditTrail;
  onOffset: (offset: number) => void;
}) {
  const dari = data.jumlahTotal === 0 ? 0 : data.offset + 1;
  const sampai = Math.min(data.offset + data.baris.length, data.jumlahTotal);
  const adaSebelum = data.offset > 0;
  const adaSesudah = data.offset + data.baris.length < data.jumlahTotal;

  const kolom = useMemo(
    () => [
      {
        key: "waktu",
        header: "Waktu",
        width: "190px",
        render: (r: BarisAuditTrail) => waktuLengkap(r.waktu),
      },
      {
        key: "namaUser",
        header: "Pengguna",
        width: "180px",
        render: (r: BarisAuditTrail) =>
          r.namaUser ?? <span className="sel-kosong">Bukan pengguna staf</span>,
      },
      { key: "aksi", header: "Aksi", width: "200px" },
      { key: "entitas", header: "Entitas", width: "180px" },
      {
        key: "hasil",
        header: "Hasil",
        width: "140px",
        render: (r: BarisAuditTrail) => (
          <StatusBadge
            status={r.hasil}
            tone={r.hasil === "SUKSES" ? "success" : "danger"}
            label={r.hasil === "SUKSES" ? "Berhasil" : "Ditolak"}
          />
        ),
      },
      {
        key: "keterangan",
        header: "Keterangan",
        render: (r: BarisAuditTrail) => (
          <span className="sel-ringkas">{r.keterangan ?? "Tidak ada keterangan"}</span>
        ),
      },
      {
        key: "ip",
        header: "Alamat IP",
        width: "150px",
        render: (r: BarisAuditTrail) =>
          r.ip ?? <span className="sel-kosong">Tidak tercatat</span>,
      },
    ],
    [],
  );

  return (
    <>
      <KopLaporan header={data.header} />

      <Panel
        as="h2"
        title="Jejak audit"
        description={`Menampilkan baris ${formatCount(dari)} sampai ${formatCount(sampai)} dari ${formatCount(data.jumlahTotal)} baris yang cocok.`}
        footer={
          <div className="halaman-aksi">
            <Button
              variant="secondary"
              size="sm"
              disabled={!adaSebelum}
              onClick={() => onOffset(Math.max(0, data.offset - data.batas))}
              leading={<Icon name="arrowLeft" size={16} />}
            >
              Halaman sebelumnya
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!adaSesudah}
              onClick={() => onOffset(data.offset + data.batas)}
            >
              Halaman berikutnya
            </Button>
          </div>
        }
      >
        <TabelAudit kolom={kolom} baris={data.baris} />
      </Panel>

      <p className="page-note">
        <Icon name="info" size={16} />
        <span>
          Audit trail hanya bisa dibaca. Tidak ada kontrol untuk mengubah atau menghapus barisnya
          di halaman ini, dan tidak ada endpoint di server yang bisa melakukannya.
        </span>
      </p>
    </>
  );
}

function TabelAudit({
  kolom,
  baris,
}: {
  kolom: readonly {
    key: string;
    header: string;
    width?: string;
    render?: (row: BarisAuditTrail) => ReactNode;
  }[];
  baris: readonly BarisAuditTrail[];
}) {
  return (
    <>
      <div className="daftar-tabel">
        <table className="table">
          <thead>
            <tr>
              {kolom.map((k) => (
                <th key={k.key} scope="col" style={k.width ? { width: k.width } : undefined}>
                  {k.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {baris.length === 0 ? (
              <tr className="table-state">
                <td colSpan={kolom.length}>
                  <span className="table-state-title">Tidak ada jejak audit pada rentang ini</span>
                  <span className="table-state-desc">
                    Tidak ada aktivitas yang cocok dengan tanggal dan penyaring yang dipilih.
                  </span>
                </td>
              </tr>
            ) : (
              baris.map((row) => (
                <tr key={row.id}>
                  {kolom.map((k) => (
                    <td key={k.key}>{k.render ? k.render(row) : String((row as never)[k.key as never] ?? "")}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="daftar-kartu">
        {baris.length === 0 ? (
          <div className="antrean-kosong">
            <span className="antrean-kosong-icon" aria-hidden="true">
              <Icon name="list" size={20} />
            </span>
            <p className="antrean-kosong-title">Tidak ada jejak audit pada rentang ini</p>
            <p className="antrean-kosong-desc">
              Tidak ada aktivitas yang cocok dengan tanggal dan penyaring yang dipilih.
            </p>
          </div>
        ) : (
          <ul className="kartu-list">
            {baris.map((row) => (
              <li className="kartu-item" key={row.id}>
                <div className="kartu-btn is-statis">
                  <span className="kartu-head">
                    <span className="kartu-judul">{row.aksi}</span>
                    <StatusBadge
                      status={row.hasil}
                      tone={row.hasil === "SUKSES" ? "success" : "danger"}
                      label={row.hasil === "SUKSES" ? "Berhasil" : "Ditolak"}
                    />
                  </span>
                  <span className="kartu-sub">
                    {row.entitas}, {row.namaUser ?? "bukan pengguna staf"}
                  </span>
                  <span className="kartu-foot">
                    <span className="kartu-meta">{waktuLengkap(row.waktu)}</span>
                    <span className="kartu-nilai">
                      <span className="kartu-nilai-label">Alamat IP</span>
                      <span className="kartu-nilai-val">{row.ip ?? "Tidak tercatat"}</span>
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** A timestamp with its clock time, which an audit line is useless without.
 *  `formatDate` alone would collapse a whole day's activity onto one label. */
function waktuLengkap(waktu: string): string {
  const tanggal = formatDate(waktu.slice(0, 10));
  const jam = waktu.slice(11, 19);
  return jam === "" ? tanggal : `${tanggal}, ${jam}`;
}

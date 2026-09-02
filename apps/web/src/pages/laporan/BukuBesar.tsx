// 22. Buku Besar, spec 10.3. Saldo awal, every movement, saldo akhir, for one
// account.
//
// IT DRILLS DOWN TO THE JOURNAL, and that is the point of the report rather
// than a nicety. Spec 11: "angka yang tidak bisa ditelusuri asalnya tidak
// dipercaya user". The API returns `jurnalId` and `jurnalBarisId` on every
// movement precisely so the link is EXACT; a link built from `noJurnal` alone
// would be a search, and a search can land on the wrong entry.
//
// THE ACCOUNT PICKER READS THE CHART, NOT A LIST OF ITS OWN. The postable
// accounts come from report 16's endpoint, so the two reports cannot disagree
// about which accounts exist. Only postable accounts are offered: a header
// account has no movements of its own and asking for one would answer an empty
// ledger that reads like an account with no activity.
import { useMemo } from "react";
import {
  DataTable,
  ErrorState,
  Icon,
  Panel,
  Select,
  formatDate,
  type Column,
} from "@krakatausteel/ui";
import {
  baganAkun,
  bukuBesar,
  type BarisBukuBesar,
  type LaporanBukuBesar,
} from "../../api/laporan";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useRouter } from "../../router";
import { AntreanKosong, TautanDokumen } from "../shared/parts";
import { HalamanLaporan, KopLaporan, Nilai, useFilterLaporan } from "./parts";

/** Where a movement drills to. The journal screen reads both ids from the
 *  query string, so the link opens the ENTRY and highlights the LINE. */
export function tautanJurnal(row: BarisBukuBesar): string {
  return `/jurnal?jurnal=${encodeURIComponent(row.jurnalId)}&baris=${encodeURIComponent(row.jurnalBarisId)}`;
}

export function BukuBesarPage({ route }: { route: PageRoute }) {
  const { query, setQuery } = useRouter();

  const chart = useApi(() => baganAkun(true), []);
  const akunPostable = useMemo(
    () => (chart.data?.baris ?? []).filter((akun) => akun.isPostable),
    [chart.data],
  );

  const akunUrl = query.get("akun");
  const akunId =
    akunUrl && akunPostable.some((akun) => akun.akunId === akunUrl)
      ? akunUrl
      : (akunPostable[0]?.akunId ?? null);
  const akunTerpilih = akunPostable.find((akun) => akun.akunId === akunId) ?? null;

  const pemilihAkun = (
    <label className="filter-laporan-group">
      <span className="filter-laporan-label">Akun</span>
      <Select
        aria-label="Akun buku besar"
        value={akunId ?? ""}
        disabled={akunPostable.length === 0}
        onChange={(event) => setQuery("akun", event.currentTarget.value)}
        options={
          akunPostable.length === 0
            ? [
                {
                  value: "",
                  label:
                    chart.status === "memuat"
                      ? "Memuat bagan akun"
                      : chart.status === "gagal"
                        ? "Bagan akun gagal dimuat"
                        : "Tidak ada akun yang bisa dijurnal",
                },
              ]
            : akunPostable.map((akun) => ({
                value: akun.akunId,
                label: `${akun.kode} ${akun.nama}`,
              }))
        }
      />
    </label>
  );

  const filter = useFilterLaporan({
    tambahan: pemilihAkun,
    ringkasTambahan: akunTerpilih ? `${akunTerpilih.kode} ${akunTerpilih.nama}` : "Akun belum dipilih",
  });

  const hasil = useApi(
    () =>
      bukuBesar({
        periodeId: filter.periodeId ?? "",
        cabangId: filter.cabangId,
        akunId: akunId ?? "",
      }),
    [filter.periodeId, filter.cabangId, akunId],
    { enabled: filter.siap && filter.periodeId !== null && akunId !== null },
  );

  return (
    <HalamanLaporan
      route={route}
      filter={filter}
      hasil={hasil}
      judul="Buku Besar"
      sumber="GET /api/laporan/buku-besar"
      sebelum={
        chart.status === "gagal" ? (
          <ErrorState
            title="Gagal memuat daftar akun"
            detail={chart.error}
            sumber="GET /api/laporan/bagan-akun"
            onRetry={chart.reload}
          />
        ) : null
      }
    >
      {(data: LaporanBukuBesar) => (
        <>
          <KopLaporan header={data.header} />

          <Panel
            as="h2"
            title={`${data.akunKode} ${data.akunNama}`}
            description={`Saldo normal ${data.saldoNormal === "D" ? "Debit" : "Kredit"}. Setiap mutasi di bawah bisa dibuka sampai ke jurnalnya.`}
          >
            <ul className="ringkas-angka">
              <li className="ringkas-angka-item">
                <span className="ringkas-angka-label">Saldo awal</span>
                <span className="ringkas-angka-baris">
                  <span className="ringkas-angka-key">Nilai</span>
                  <Nilai angka={data.saldoAwal} />
                </span>
              </li>
              <li className="ringkas-angka-item">
                <span className="ringkas-angka-label">Total mutasi</span>
                <span className="ringkas-angka-baris">
                  <span className="ringkas-angka-key">Debit</span>
                  <Nilai angka={data.totalDebit} />
                </span>
                <span className="ringkas-angka-baris">
                  <span className="ringkas-angka-key">Kredit</span>
                  <Nilai angka={data.totalKredit} />
                </span>
              </li>
              <li className="ringkas-angka-item">
                <span className="ringkas-angka-label">Saldo akhir</span>
                <span className="ringkas-angka-baris">
                  <span className="ringkas-angka-key">Nilai</span>
                  <Nilai angka={data.saldoAkhir} />
                </span>
              </li>
            </ul>
          </Panel>

          <Panel as="h2" title="Mutasi" description={`${data.mutasi.length} baris jurnal.`}>
            <MutasiBukuBesar mutasi={data.mutasi} />
          </Panel>

          <p className="page-note">
            <Icon name="info" size={16} />
            <span>
              Tautan No Jurnal membuka entri jurnalnya beserta baris yang bersangkutan. Halaman
              jurnal itu sendiri dibangun pada fase jurnal, jadi untuk sekarang tautan tersebut
              berhenti di halaman daftar jurnal dengan nomor entri sudah terbawa.
            </span>
          </p>
        </>
      )}
    </HalamanLaporan>
  );
}

function MutasiBukuBesar({ mutasi }: { mutasi: readonly BarisBukuBesar[] }) {
  const columns: readonly Column<BarisBukuBesar>[] = [
    { key: "tanggal", header: "Tanggal", type: "date", width: "110px" },
    {
      key: "noJurnal",
      header: "No jurnal",
      width: "160px",
      render: (row) => <TautanDokumen to={tautanJurnal(row)}>{row.noJurnal}</TautanDokumen>,
    },
    { key: "jenisJurnal", header: "Jenis", width: "150px" },
    {
      key: "keterangan",
      header: "Keterangan",
      render: (row) => <span className="sel-ringkas">{row.keterangan}</span>,
    },
    {
      key: "debit",
      header: "Debit",
      type: "money",
      width: "150px",
      render: (row) => <Nilai angka={row.debit} />,
    },
    {
      key: "kredit",
      header: "Kredit",
      type: "money",
      width: "150px",
      render: (row) => <Nilai angka={row.kredit} />,
    },
    {
      key: "saldoBerjalan",
      header: "Saldo berjalan",
      type: "money",
      width: "160px",
      render: (row) => <Nilai angka={row.saldoBerjalan} />,
    },
  ];

  return (
    <>
      <div className="daftar-tabel">
        <DataTable
          columns={columns}
          rows={mutasi}
          rowKey={(row) => row.jurnalBarisId}
          emptyTitle="Tidak ada mutasi pada periode ini"
          emptyDescription="Akun ini tidak bergerak pada periode dan cabang yang dipilih. Saldo awal dan saldo akhir tetap sama."
        />
      </div>
      <div className="daftar-kartu">
        {mutasi.length === 0 ? (
          <AntreanKosong
            icon="list"
            title="Tidak ada mutasi pada periode ini"
            description="Akun ini tidak bergerak pada periode dan cabang yang dipilih. Saldo awal dan saldo akhir tetap sama."
          />
        ) : (
          <ul className="kartu-list">
            {mutasi.map((row) => (
              <li className="kartu-item" key={row.jurnalBarisId}>
                <TautanDokumen to={tautanJurnal(row)}>
                  <span className="mutasi-kartu">
                    <span className="kartu-head">
                      <span className="kartu-judul">{row.noJurnal}</span>
                      <span className="kartu-meta">{formatDate(row.tanggal)}</span>
                    </span>
                    <span className="kartu-sub">{row.keterangan}</span>
                    <span className="mutasi-angka">
                      <span className="mutasi-angka-sel">
                        <span className="mutasi-angka-key">Debit</span>
                        <Nilai angka={row.debit} />
                      </span>
                      <span className="mutasi-angka-sel">
                        <span className="mutasi-angka-key">Kredit</span>
                        <Nilai angka={row.kredit} />
                      </span>
                      <span className="mutasi-angka-sel">
                        <span className="mutasi-angka-key">Saldo</span>
                        <Nilai angka={row.saldoBerjalan} />
                      </span>
                    </span>
                  </span>
                </TautanDokumen>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

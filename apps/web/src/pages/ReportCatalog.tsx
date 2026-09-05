// The index for one of spec 10's four groupings.
//
// THE LIST COMES FROM THE SERVER, NOT FROM THIS REPOSITORY. `GET
// /laporan/katalog` is the one place that knows which reports the engine
// actually answers, and a hand kept copy in the frontend is precisely how a
// shipped report becomes invisible: it ships, nobody adds the line, and the
// only sign is that nobody ever opens it. So every row here is an entry the
// server sent, and ../reports.ts is demoted from "the inventory" to what it
// really is, the local metadata (route slug, grouping, key columns) that
// dresses an entry the server named.
//
// THREE STATES A ROW CAN BE IN, AND ALL THREE ARE VISIBLE:
//
//   the server lists it and it has a screen  -> a link that opens the report;
//   the server lists it and it has no screen -> a row saying the screen is not
//                                               built, never a silent omission;
//   the server lists a number this build has never heard of -> a row on the
//                                               Laporan Lainnya page under its
//                                               own heading, because a new
//                                               report with nowhere to live is
//                                               still a report that must be
//                                               seen.
//
// AND ONE ENTRY IS NOT THE SERVER CATALOGUE'S TO GIVE. Report 24, RKA versus
// Realisasi, belongs to modules/rka, and modules/laporan's catalogue documents
// its own absence ("a single catalogue across all 31 is a composition above
// both, and it is one entry"). This screen IS that composition, and the entry
// is named once, below, rather than smuggled in through a range check.
import { useMemo, useState } from "react";
import { DataTable, Icon, Panel, SearchInput, StatusBadge, type Column } from "@krakatausteel/ui";
import { katalogLaporan, type EntriKatalogLaporan } from "../api/laporan";
import { useApi } from "../api/useApi";
import { adaLayarLaporan } from "./laporan/layar";
import { AntreanKosong, Muat } from "./shared/parts";
import { useRouter } from "../router";
import { reportPath, REPORTS, type ReportGroup, type ReportGroupId } from "../reports";

/**
 * The one report spec 10 lists that `GET /laporan/katalog` deliberately does
 * not. Written out with its source so a reader can see it is a composition of
 * two modules and not an oversight, and so the day modules/rka publishes a
 * catalogue of its own this constant is the single thing that is deleted.
 */
const DI_LUAR_KATALOG_LAPORAN: readonly EntriKatalogLaporan[] = [
  {
    nomor: 24,
    kode: "RKA_VS_REALISASI",
    nama: "Laporan RKA versus Realisasi",
    path: "/rka/laporan",
    perluPeriode: true,
    perluAkun: false,
  },
];

interface BarisKatalog {
  nomor: number;
  kode: string;
  nama: string;
  /** Local metadata, absent when this build does not know the number. */
  kolomKunci: string;
  pengelompokan: string;
  /** Where the screen lives, or null when there is no screen to open. */
  tujuan: string | null;
  perluPeriode: boolean;
  perluAkun: boolean;
  /** True when ../reports.ts has no entry for this number at all. */
  baru: boolean;
}

const TANPA_METADATA = "Belum dikenali build ini";

function barisUntuk(entri: EntriKatalogLaporan): BarisKatalog {
  const lokal = REPORTS.find((report) => report.no === entri.nomor);
  const punyaLayar = adaLayarLaporan(entri.nomor);
  return {
    nomor: entri.nomor,
    kode: entri.kode,
    // The SERVER's name, so the index, the page heading and the printed header
    // are one sentence. The local `nama` is only a fallback for an entry the
    // server did not send at all.
    nama: entri.nama,
    kolomKunci: lokal?.kolomKunci ?? TANPA_METADATA,
    pengelompokan: lokal?.pengelompokan ?? TANPA_METADATA,
    tujuan: lokal && punyaLayar ? reportPath(lokal.slug) : null,
    perluPeriode: entri.perluPeriode,
    perluAkun: entri.perluAkun,
    baru: lokal === undefined,
  };
}

/** Which of the four index pages an entry belongs on. */
function kelompokDari(entri: EntriKatalogLaporan): ReportGroupId {
  return REPORTS.find((report) => report.no === entri.nomor)?.group ?? "lainnya";
}

function Ketersediaan({ baris }: { baris: BarisKatalog }) {
  if (baris.tujuan !== null) {
    return <StatusBadge status="Siap dibuka" tone="success" />;
  }
  return <StatusBadge status="Layar belum dibangun" tone="neutral" />;
}

/**
 * ONE SHAPE, WHETHER OR NOT THE REPORT OPENS.
 *
 * A row that has a screen is a button and a row that has none is a plain card,
 * and both carry the same three parts in the same places, so a list of eleven
 * reads as one list. A card with no screen is deliberately NOT a disabled
 * button: Chrome greys a disabled button's whole subtree, which would render a
 * perfectly readable report name in the ink reserved for something broken.
 *
 * AND THE NAME IS THE WIDEST THING ON THE CARD, allowed two lines, because
 * finding a report by its name is the only reason this page exists. The first
 * version put the name on one clipped line beside a badge and produced
 * "26. Laporan Portal Non..." on a phone, which answers nothing. The badge
 * moved to the footer to pay for it.
 */
function KartuKatalog({ baris, buka }: { baris: BarisKatalog; buka: (to: string) => void }) {
  const isi = (
    <>
      <span className="katalog-kartu-judul">
        {baris.nomor}. {baris.nama}
      </span>
      <span className="katalog-kartu-sub">{baris.kolomKunci}</span>
      <span className="katalog-kartu-foot">
        <span className="katalog-kartu-meta">{baris.pengelompokan}</span>
        <Ketersediaan baris={baris} />
      </span>
    </>
  );

  if (baris.tujuan === null) return <div className="katalog-kartu is-statis">{isi}</div>;
  return (
    <button
      type="button"
      className="katalog-kartu"
      onClick={() => buka(baris.tujuan as string)}
    >
      {isi}
    </button>
  );
}

export function ReportCatalog({ group }: { group: ReportGroup }) {
  const { navigate } = useRouter();
  const [cari, setCari] = useState("");
  const hasil = useApi(() => katalogLaporan(), []);

  return (
    <div className="page laporan-page">
      <header className="page-head">
        <p className="page-crumb">Laporan</p>
        <h1 className="page-title">{group.label}</h1>
        <p className="page-sub">{group.description}</p>
      </header>

      <Muat
        hasil={hasil}
        judul="katalog laporan"
        sumber="GET /api/laporan/katalog"
        diamLabel="Katalog laporan belum diminta."
      >
        {(data) => (
          <IsiKatalog
            group={group}
            entri={[...data.data, ...DI_LUAR_KATALOG_LAPORAN]}
            cari={cari}
            setCari={setCari}
            buka={navigate}
          />
        )}
      </Muat>
    </div>
  );
}

function IsiKatalog({
  group,
  entri,
  cari,
  setCari,
  buka,
}: {
  group: ReportGroup;
  entri: readonly EntriKatalogLaporan[];
  cari: string;
  setCari: (nilai: string) => void;
  buka: (to: string) => void;
}) {
  const semua = useMemo(
    () =>
      entri
        .filter((e) => kelompokDari(e) === group.id)
        .map(barisUntuk)
        .sort((a, b) => a.nomor - b.nomor),
    [entri, group.id],
  );

  const rows = useMemo(() => {
    const kunci = cari.trim().toLowerCase();
    if (kunci === "") return semua;
    return semua.filter(
      (baris) =>
        baris.nama.toLowerCase().includes(kunci) ||
        baris.kode.toLowerCase().includes(kunci) ||
        baris.kolomKunci.toLowerCase().includes(kunci),
    );
  }, [semua, cari]);

  const baru = semua.filter((baris) => baris.baru);
  const belumAdaLayar = semua.filter((baris) => baris.tujuan === null);

  /*
   * FOUR COLUMNS, NOT FIVE. The key columns of a report are a long sentence,
   * and given a column of their own they squeezed the report NAME into three
   * wrapped lines while making one row five times taller than its neighbour.
   * They belong under the name, on one clipped line, so every row is the same
   * height and the thing a reader is scanning for is the widest thing on it.
   */
  const columns: readonly Column<BarisKatalog>[] = [
    { key: "nomor", header: "No", type: "count", sortable: true, width: "64px" },
    {
      key: "nama",
      header: "Laporan",
      sortable: true,
      render: (baris) => (
        <span className="sel-nama">
          <span className="sel-nama-judul">{baris.nama}</span>
          <span className="sel-nama-sub">{baris.kolomKunci}</span>
        </span>
      ),
    },
    { key: "pengelompokan", header: "Pengelompokan", width: "280px" },
    {
      key: "tujuan",
      header: "Ketersediaan",
      width: "180px",
      render: (baris) => <Ketersediaan baris={baris} />,
    },
  ];

  return (
    <>
      <Panel
        as="h2"
        title="Daftar laporan"
        description={`${semua.length} laporan pada kelompok ini, dibaca dari katalog server. ${belumAdaLayar.length} di antaranya belum punya layar.`}
        aside={
          <SearchInput
            label="Cari laporan"
            placeholder="Cari laporan"
            value={cari}
            onChange={(event) => setCari(event.currentTarget.value)}
          />
        }
      >
        {/* A DESK TABLE AND A PHONE LIST, ONE ARRAY. A five column catalogue
            forced sideways on a 320px screen is the scroll nobody reads, and
            this list is how a reader FINDS a report, so it must be legible on
            the device it is most often opened on. */}
        <div className="daftar-tabel">
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(baris) => baris.kode}
            emptyTitle="Tidak ada laporan yang cocok"
            emptyDescription="Ubah kata pencarian untuk melihat laporan lain pada kelompok ini."
            onRowClick={(baris) => {
              if (baris.tujuan !== null) buka(baris.tujuan);
            }}
          />
        </div>

        <div className="daftar-kartu">
          {rows.length === 0 ? (
            <AntreanKosong
              title="Tidak ada laporan yang cocok"
              description="Ubah kata pencarian untuk melihat laporan lain pada kelompok ini."
            />
          ) : (
            <ul className="katalog-kartu-list">
              {rows.map((baris) => (
                <li className="katalog-kartu-item" key={baris.kode}>
                  <KartuKatalog baris={baris} buka={buka} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>

      {baru.length === 0 ? null : (
        <Panel
          as="h2"
          title="Laporan baru dari katalog server"
          description="Server mengirim laporan yang belum dikenali build aplikasi ini. Laporan ini tetap ditampilkan supaya tidak ada laporan yang hidup di server tetapi tidak terlihat sama sekali di sini."
        >
          <ul className="ringkas-angka">
            {baru.map((baris) => (
              <li className="ringkas-angka-item" key={baris.kode}>
                <span className="ringkas-angka-label">
                  {baris.nomor}. {baris.nama}
                </span>
                <span className="ringkas-angka-baris">
                  <span className="ringkas-angka-key">Kode</span>
                  <span className="angka">{baris.kode}</span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <p className="page-note">
        <Icon name="info" size={16} />
        <span>
          Daftar ini dibaca dari katalog server, bukan dari daftar yang ditulis tangan di
          aplikasi, sehingga laporan yang sudah hidup di server tidak bisa hilang dari halaman
          ini. Filter periode dan cabang ada di dalam setiap laporan, bukan di indeks ini, karena
          keduanya adalah bagian dari laporan yang dicetak.
        </span>
      </p>
    </>
  );
}

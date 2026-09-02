// 23. Neraca Lajur, spec 10.3. Six columns, three pairs: Saldo Awal D and K,
// Mutasi D and K, Saldo Akhir D and K.
//
// THE FOOTING BALANCES IN ALL THREE PAIRS OR THE REPORT IS NOT PRINTED. The
// engine refuses to return one that does not, so a page that renders is one
// whose three pairs tie. The totals row shows all six figures rather than a
// tick, because a worksheet exists to be checked by hand and a claim that it
// balances is worth less than the six numbers that prove it.
//
// SIX MONEY COLUMNS DO NOT FIT A PHONE, and shrinking them is how an
// accounting table becomes a sideways scroll nobody reads. The same rows
// render as one card per account with the three pairs stacked, driven by the
// same array, so the two shapes cannot disagree about what is in the report.
import { DataTable, Icon, Panel, type Column } from "@krakatausteel/ui";
import { neracaLajur, type BarisNeracaLajur, type LaporanNeracaLajur } from "../../api/laporan";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { AntreanKosong } from "../shared/parts";
import { HalamanLaporan, KopLaporan, Nilai, useFilterLaporan } from "./parts";

const LABEL_TIPE: Record<string, string> = {
  ASET: "Aset",
  LIABILITAS: "Liabilitas",
  ASET_NETO: "Aset Neto",
  PENDAPATAN: "Pendapatan",
  BEBAN: "Beban",
};

export function NeracaLajurPage({ route }: { route: PageRoute }) {
  const filter = useFilterLaporan();
  const hasil = useApi(
    () => neracaLajur({ periodeId: filter.periodeId ?? "", cabangId: filter.cabangId }),
    [filter.periodeId, filter.cabangId],
    { enabled: filter.siap && filter.periodeId !== null },
  );

  return (
    <HalamanLaporan
      route={route}
      filter={filter}
      hasil={hasil}
      judul="Neraca Lajur"
      sumber="GET /api/laporan/neraca-lajur"
    >
      {(data: LaporanNeracaLajur) => {
        const columns: readonly Column<BarisNeracaLajur>[] = [
          { key: "kode", header: "Kode", width: "110px" },
          {
            key: "nama",
            header: "Nama akun",
            render: (row) => (
              <span className="sel-utama">
                <span className="sel-utama-judul">{row.nama}</span>
                <span className="sel-utama-sub">
                  {LABEL_TIPE[row.tipe] ?? row.tipe}, saldo normal{" "}
                  {row.saldoNormal === "D" ? "Debit" : "Kredit"}
                </span>
              </span>
            ),
          },
          {
            key: "saldoAwalDebit",
            header: "Saldo awal D",
            type: "money",
            width: "140px",
            render: (row) => <Nilai angka={row.saldoAwalDebit} />,
            footer: <Nilai angka={data.total.saldoAwalDebit} />,
          },
          {
            key: "saldoAwalKredit",
            header: "Saldo awal K",
            type: "money",
            width: "140px",
            render: (row) => <Nilai angka={row.saldoAwalKredit} />,
            footer: <Nilai angka={data.total.saldoAwalKredit} />,
          },
          {
            key: "mutasiDebit",
            header: "Mutasi D",
            type: "money",
            width: "140px",
            render: (row) => <Nilai angka={row.mutasiDebit} />,
            footer: <Nilai angka={data.total.mutasiDebit} />,
          },
          {
            key: "mutasiKredit",
            header: "Mutasi K",
            type: "money",
            width: "140px",
            render: (row) => <Nilai angka={row.mutasiKredit} />,
            footer: <Nilai angka={data.total.mutasiKredit} />,
          },
          {
            key: "saldoAkhirDebit",
            header: "Saldo akhir D",
            type: "money",
            width: "140px",
            render: (row) => <Nilai angka={row.saldoAkhirDebit} />,
            footer: <Nilai angka={data.total.saldoAkhirDebit} />,
          },
          {
            key: "saldoAkhirKredit",
            header: "Saldo akhir K",
            type: "money",
            width: "140px",
            render: (row) => <Nilai angka={row.saldoAkhirKredit} />,
            footer: <Nilai angka={data.total.saldoAkhirKredit} />,
          },
        ];

        return (
          <>
            <KopLaporan header={data.header} />

            <Panel
              as="h2"
              title="Neraca lajur"
              description={`${data.baris.length} akun. Baris total wajib seimbang pada ketiga pasang kolom, dan server menolak mengeluarkan neraca lajur yang tidak seimbang.`}
            >
              <div className="daftar-tabel">
                <DataTable
                  columns={columns}
                  rows={data.baris}
                  rowKey={(row) => row.akunId}
                  emptyTitle="Tidak ada akun bersaldo pada periode ini"
                  emptyDescription="Tidak ada satu akun pun dengan saldo awal, mutasi, atau saldo akhir pada periode dan cabang yang dipilih."
                />
              </div>
              <div className="daftar-kartu">
                {data.baris.length === 0 ? (
                  <AntreanKosong
                    icon="list"
                    title="Tidak ada akun bersaldo pada periode ini"
                    description="Tidak ada satu akun pun dengan saldo awal, mutasi, atau saldo akhir pada periode dan cabang yang dipilih."
                  />
                ) : (
                  <ul className="kartu-list">
                    {data.baris.map((row) => (
                      <li className="kartu-item is-statis" key={row.akunId}>
                        <PasanganKartu
                          judul={`${row.kode} ${row.nama}`}
                          sub={`${LABEL_TIPE[row.tipe] ?? row.tipe}, saldo normal ${row.saldoNormal === "D" ? "Debit" : "Kredit"}`}
                          row={row}
                        />
                      </li>
                    ))}
                    <li className="kartu-item is-statis is-total" key="total">
                      <PasanganKartu
                        judul="Total"
                        sub="Ketiga pasang kolom wajib seimbang"
                        row={{
                          akunId: "total",
                          kode: "",
                          nama: "Total",
                          tipe: "ASET",
                          saldoNormal: "D",
                          ...data.total,
                        }}
                      />
                    </li>
                  </ul>
                )}
              </div>
            </Panel>

            <p className="page-note">
              <Icon name="info" size={16} />
              <span>
                Nilai nol ditampilkan sebagai 0,00 dan tidak pernah dikosongkan, karena baris yang
                kosong tidak bisa dibedakan dari baris yang gagal terbaca.
              </span>
            </p>
          </>
        );
      }}
    </HalamanLaporan>
  );
}

function PasanganKartu({
  judul,
  sub,
  row,
}: {
  judul: string;
  sub: string;
  row: BarisNeracaLajur;
}) {
  const pasangan = [
    { label: "Saldo awal", debit: row.saldoAwalDebit, kredit: row.saldoAwalKredit },
    { label: "Mutasi", debit: row.mutasiDebit, kredit: row.mutasiKredit },
    { label: "Saldo akhir", debit: row.saldoAkhirDebit, kredit: row.saldoAkhirKredit },
  ];
  return (
    <div className="lajur-kartu">
      <p className="kartu-judul">{judul}</p>
      <p className="kartu-sub">{sub}</p>
      <dl className="lajur-grid">
        {pasangan.map((pasang) => (
          <div className="lajur-pasang" key={pasang.label}>
            <dt className="lajur-label">{pasang.label}</dt>
            <dd className="lajur-nilai">
              <span className="lajur-key">Debit</span>
              <Nilai angka={pasang.debit} />
            </dd>
            <dd className="lajur-nilai">
              <span className="lajur-key">Kredit</span>
              <Nilai angka={pasang.kredit} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

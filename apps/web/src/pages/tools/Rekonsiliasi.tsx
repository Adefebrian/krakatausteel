// Rekonsiliasi Sub Ledger Piutang, spec 9.6 and spec 8.4 check 10.
//
// THE PER AKAD LIST IS THE PRODUCT. A total alone is useless operationally:
// two akad with offsetting errors net to zero, and the only thing an operator
// can act on is WHICH akad is wrong and by how much. So the per akad table
// comes first on this page and the per cabang summary sits under it as
// context, not the other way round.
//
// IT DIAGNOSES AND NEVER REPAIRS, the same as the integrity page. Everything
// here is one GET; a difference is corrected in the module that owns the
// record, never from this screen.
//
// A DIFFERENCE IS SIGNED, AND BOTH DIRECTIONS ARE REAL. `selisih` is
// `saldoSubLedger - saldoBukuBesar`: positive means the kartu piutang carries
// more than the ledger, negative the reverse. Neither is "the good one", so the
// figure is printed with its sign in accounting parentheses rather than as an
// absolute value with a label.
import { Bento, BentoItem, Icon, Panel, StatusBadge, formatCount, formatDate } from "@krakatausteel/ui";
import {
  rekonsiliasiPiutang,
  type BarisRekonsiliasiPiutang,
  type RingkasanCabangRekonsiliasi,
} from "../../api/tools";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useRouter } from "../../router";
import {
  CatatanOtorisasi,
  DaftarDokumen,
  HalamanModul,
  Muat,
  Penyaring,
  useLayarKecil,
  useLingkupCabang,
  type ColumnSpec,
} from "../shared/parts";
import { CatatanDiagnosa, KartuRingkas, teksUang } from "./parts";

const KOLOM_AKAD: readonly ColumnSpec<BarisRekonsiliasiPiutang>[] = [
  {
    key: "noAkad",
    header: "Akad",
    sortable: true,
    render: (row) => (
      <span className="sel-utama is-lebar">
        <span className="sel-utama-judul">{row.noAkad}</span>
        <span className="sel-utama-sub">{row.namaMitra}</span>
      </span>
    ),
  },
  {
    key: "statusAkad",
    header: "Status akad",
    sortable: true,
    width: "170px",
    render: (row) => <StatusBadge status={row.statusAkad} />,
  },
  {
    key: "saldoSubLedger",
    header: "Kartu piutang",
    type: "money",
    sortable: true,
    width: "180px",
    render: (row) => <span className="angka">{teksUang(row.saldoSubLedger)}</span>,
  },
  {
    key: "saldoBukuBesar",
    header: "Buku besar",
    type: "money",
    sortable: true,
    width: "180px",
    render: (row) => <span className="angka">{teksUang(row.saldoBukuBesar)}</span>,
  },
  {
    key: "selisih",
    header: "Selisih",
    type: "money",
    sortable: true,
    width: "180px",
    sortValue: (row) => Number(row.selisih),
    render: (row) => <span className="angka">{teksUang(row.selisih)}</span>,
  },
];

const KOLOM_CABANG: readonly ColumnSpec<RingkasanCabangRekonsiliasi>[] = [
  {
    key: "namaCabang",
    header: "Cabang",
    sortable: true,
    render: (row) => (
      <span className="sel-utama is-lebar">
        <span className="sel-utama-judul">{row.namaCabang}</span>
        <span className="sel-utama-sub">Kode {row.kodeCabang}</span>
      </span>
    ),
  },
  {
    key: "jumlahAkadSelisih",
    header: "Akad selisih",
    type: "count",
    sortable: true,
    width: "170px",
    render: (row) =>
      `${formatCount(row.jumlahAkadSelisih)} dari ${formatCount(row.jumlahAkad)}`,
  },
  {
    key: "totalSubLedger",
    header: "Kartu piutang",
    type: "money",
    sortable: true,
    width: "180px",
    render: (row) => <span className="angka">{teksUang(row.totalSubLedger)}</span>,
  },
  {
    key: "totalBukuBesar",
    header: "Buku besar",
    type: "money",
    sortable: true,
    width: "180px",
    render: (row) => <span className="angka">{teksUang(row.totalBukuBesar)}</span>,
  },
  {
    key: "totalSelisih",
    header: "Selisih",
    type: "money",
    sortable: true,
    width: "180px",
    sortValue: (row) => Number(row.totalSelisih),
    render: (row) => <span className="angka">{teksUang(row.totalSelisih)}</span>,
  },
];

export function Rekonsiliasi({ route }: { route: PageRoute }) {
  const { query, setQuery } = useRouter();
  const kecil = useLayarKecil();
  const lingkup = useLingkupCabang("Cabang yang direkonsiliasi");
  const semuaAkad = query.get("akad") === "semua";

  const laporan = useApi(
    () => rekonsiliasiPiutang({ cabangId: lingkup.cabangId, hanyaSelisih: !semuaAkad }),
    [lingkup.cabangId, semuaAkad],
  );

  const isiFilter = (
    <div className="filter-laporan">
      {lingkup.kontrol}
      <label className="filter-laporan-check">
        <input
          type="checkbox"
          checked={semuaAkad}
          onChange={(event) => setQuery("akad", event.currentTarget.checked ? "semua" : null)}
        />
        <span>Tampilkan seluruh akad, bukan hanya yang selisih</span>
      </label>
      <p className="filter-laporan-catatan">
        Bawaan halaman ini hanya menampilkan akad yang selisih, karena daftar akad yang sudah cocok
        bukan jawaban atas pertanyaan apa yang harus diperbaiki.
      </p>
    </div>
  );

  return (
    <HalamanModul route={route}>
      {kecil ? (
        <Penyaring ringkas={`${lingkup.ringkas}, ${semuaAkad ? "seluruh akad" : "hanya selisih"}`}>
          {isiFilter}
        </Penyaring>
      ) : (
        isiFilter
      )}

      <Muat
        hasil={laporan}
        judul="hasil rekonsiliasi piutang"
        sumber="GET /api/tools/rekonsiliasi/piutang"
      >
        {(data) => (
          <>
            <Bento columns={4}>
              <BentoItem span="sm">
                <KartuRingkas
                  judul="Kondisi rekonsiliasi"
                  nilai={data.cocok ? "Cocok" : "Ada selisih"}
                  catatan={
                    data.cocok
                      ? "Seluruh akad pada lingkup ini cocok antara kartu piutang dan buku besar."
                      : "Ada akad yang saldo kartu piutangnya berbeda dari saldo buku besar."
                  }
                />
              </BentoItem>
              <BentoItem span="sm">
                <KartuRingkas
                  judul="Akad selisih"
                  nilai={`${formatCount(data.jumlahAkadSelisih)} dari ${formatCount(data.jumlahAkadDiperiksa)}`}
                  catatan="Jumlah akad yang berbeda dibandingkan seluruh akad yang diperiksa pada lingkup ini."
                />
              </BentoItem>
              <BentoItem span="sm">
                <KartuRingkas
                  judul="Total selisih"
                  nilai={teksUang(data.totalSelisih)}
                  catatan="Kartu piutang dikurangi buku besar. Nol adalah syarat yang wajib tercapai sebelum periode ditutup."
                />
              </BentoItem>
              <BentoItem span="sm">
                <KartuRingkas
                  judul="Akun piutang pembanding"
                  nilai={data.akunPiutangKode}
                  catatan="Akun dibaca dari pemetaan event pencairan PUMK, bukan ditulis tetap di halaman ini."
                />
              </BentoItem>
            </Bento>

            <Panel
              as="h2"
              title="Akad penyebab selisih"
              description="Diurutkan dari selisih terbesar. Inilah daftar yang bisa ditindaklanjuti: total saja akan saling menutup antara dua akad yang salah arah."
              footer={
                <span className="panel-foot-note">
                  Sumber: GET /api/tools/rekonsiliasi/piutang. Kewenangan tools.rekonsiliasi.
                </span>
              }
            >
              <DaftarDokumen
                columns={KOLOM_AKAD}
                rows={data.baris}
                rowKey={(row) => row.akadId}
                // The phone card carries the four facts that fit on one line
                // each: which akad, whose it is, what the kartu piutang says,
                // and the difference. The ledger side is the difference away
                // and is on the table at every wider width; a sub line long
                // enough to hold both balances ellipsised the mitra name, and a
                // name a collector cannot read is worse than one figure fewer.
                kartu={(row) => ({
                  judul: row.noAkad,
                  sub: row.namaMitra,
                  meta: `Kartu piutang ${teksUang(row.saldoSubLedger)}`,
                  nilai: teksUang(row.selisih),
                  nilaiLabel: "Selisih",
                  status: <StatusBadge status={row.statusAkad} />,
                })}
                emptyTitle={
                  semuaAkad ? "Tidak ada akad pada lingkup ini" : "Tidak ada akad yang selisih"
                }
                emptyDescription={
                  semuaAkad
                    ? "Belum ada akad PUMK pada cabang yang dipilih, jadi tidak ada yang direkonsiliasi."
                    : "Seluruh akad pada lingkup ini cocok antara kartu piutang dan buku besar."
                }
              />
              {data.terpotong ? (
                <p className="rincian-potong">
                  Daftar dipotong server. {formatCount(data.jumlahAkadSelisih)} akad selisih
                  ditemukan dan hanya sebagian yang dikirim.
                </p>
              ) : null}
            </Panel>

            <Panel
              as="h2"
              title="Ringkasan per cabang"
              description="Posisi tiap cabang di balik angka total, sebagai konteks atas daftar akad di atas."
              footer={
                <span className="panel-foot-note">
                  Sumber: GET /api/tools/rekonsiliasi/piutang.
                </span>
              }
            >
              <DaftarDokumen
                columns={KOLOM_CABANG}
                rows={data.perCabang}
                rowKey={(row) => row.cabangId}
                // No meta line on this one. A branch total is nine digits and a
                // negative difference renders in parentheses, so the two
                // together left the figure on one card ellipsised and the one
                // above it whole: two rows of one list, two shapes. The branch
                // totals are context, and they are on the table at every wider
                // width.
                kartu={(row) => ({
                  judul: `${row.kodeCabang} ${row.namaCabang}`,
                  sub: `${formatCount(row.jumlahAkadSelisih)} dari ${formatCount(row.jumlahAkad)} akad selisih`,
                  nilai: teksUang(row.totalSelisih),
                  nilaiLabel: "Selisih",
                })}
                emptyTitle="Tidak ada cabang pada lingkup ini"
                emptyDescription="Tidak ada cabang dengan akad PUMK pada lingkup yang dipilih."
              />
            </Panel>

            <p className="page-note">
              <Icon name="info" size={16} />
              <span>
                Rekonsiliasi dijalankan {formatDate(data.dijalankanPada)} terhadap akun{" "}
                {data.akunPiutangKode}. Total kartu piutang {teksUang(data.totalSubLedger)}, total
                buku besar {teksUang(data.totalBukuBesar)}, selisih {teksUang(data.totalSelisih)}.
              </span>
            </p>
          </>
        )}
      </Muat>

      <CatatanDiagnosa />
      <CatatanOtorisasi tambahan="Halaman ini memerlukan kewenangan tools.rekonsiliasi." />
    </HalamanModul>
  );
}

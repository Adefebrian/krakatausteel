// One akad: the schedule, and the receipts recorded against it.
//
// TWO READS, TWO CARDS, ONE PAGE, and each read fails on its own. A schedule
// that loads while the receipts do not is still worth showing, and a page that
// refused both because one failed would hide the half that arrived.
//
// THE ID IN THE URL IS NOT AUTHORITY. `GET /mitra/akad/:id/jadwal` binds
// `mitra_id` from the session into the WHERE clause, so an id belonging to
// somebody else answers exactly what a non existent id answers: not found. This
// screen prints that answer as written and never says "milik mitra lain", which
// would rebuild the oracle the server refused to be.
//
// ON A PHONE THE SCHEDULE IS NOT A TABLE. Nine columns become a sideways
// scroll, so each instalment is one fixed shape card carrying its own due date,
// its own figure and its own state. Nothing is dropped, and the table is still
// the desk layout, driven by the same array.
import { Icon, StatusBadge, formatDate, formatRupiah, type BadgeTone } from "@krakatausteel/ui";
import {
  jadwalAkad,
  pembayaranAkad,
  type BarisJadwalMitra,
  type PembayaranMitra,
} from "../api/mitra";
import { useRouter } from "../router";
import { HalamanMitra, KartuMitra } from "./MitraApp";
import { KosongMitra, Muat, useMuatMitra } from "./pemuat";

/** `pumk_jadwal_angsuran.status`, in a borrower's words. */
const LABEL_BARIS: Readonly<Record<string, string>> = {
  BELUM_JATUH_TEMPO: "Belum jatuh tempo",
  JATUH_TEMPO: "Jatuh tempo",
  SEBAGIAN: "Terbayar sebagian",
  LUNAS: "Lunas",
  TERLAMBAT: "Terlambat",
};

const NADA_BARIS: Readonly<Record<string, BadgeTone>> = {
  BELUM_JATUH_TEMPO: "neutral",
  JATUH_TEMPO: "info",
  SEBAGIAN: "warning",
  LUNAS: "success",
  TERLAMBAT: "danger",
};

export function AkadDetailMitra({ akadId }: { akadId: string }) {
  const { navigate } = useRouter();
  const jadwal = useMuatMitra(() => jadwalAkad(akadId), [akadId]);
  const setoran = useMuatMitra(() => pembayaranAkad(akadId), [akadId]);

  return (
    <HalamanMitra
      judul="Rincian Akad"
      ringkas="Jadwal angsuran dan setoran yang sudah tercatat untuk akad ini."
    >
      <button type="button" className="mitra-kembali" onClick={() => navigate("/mitra/akad")}>
        <Icon name="arrowLeft" size={16} />
        <span>Kembali ke daftar akad</span>
      </button>

      <Muat hasil={jadwal} judul="jadwal angsuran">
        {(data) => (
          <>
            <KartuMitra
              judul={`Akad ${data.noAkad}`}
              ringkas={`Jadwal versi ${data.versi}. Versi bertambah bila akad Anda pernah dijadwalkan ulang.`}
            >
              <dl className="mitra-ringkas">
                <div className="mitra-ringkas-item">
                  <dt>Sisa pokok</dt>
                  <dd className="angka">{formatRupiah(data.outstandingPokok)}</dd>
                </div>
                <div className="mitra-ringkas-item">
                  <dt>Sisa jasa administrasi</dt>
                  <dd className="angka">{formatRupiah(data.outstandingJasa)}</dd>
                </div>
                <div className="mitra-ringkas-item">
                  <dt>Jumlah angsuran</dt>
                  <dd className="angka">{data.baris.length}</dd>
                </div>
              </dl>
            </KartuMitra>

            <KartuMitra
              judul="Jadwal angsuran"
              ringkas="Setiap baris adalah satu angsuran, dengan yang sudah terbayar di sebelahnya."
            >
              {data.baris.length === 0 ? (
                <KosongMitra
                  judul="Belum ada jadwal"
                  pesan="Jadwal angsuran akad ini belum tersusun. Hubungi kantor cabang bila Anda merasa seharusnya sudah ada."
                />
              ) : (
                <TabelJadwal baris={data.baris} />
              )}
            </KartuMitra>
          </>
        )}
      </Muat>

      <KartuMitra
        judul="Setoran yang tercatat"
        ringkas="Setoran yang sudah dibukukan, beserta pembagiannya ke pokok dan jasa administrasi."
      >
        <Muat hasil={setoran} judul="daftar setoran">
          {(data) =>
            data.data.length === 0 ? (
              <KosongMitra
                judul="Belum ada setoran tercatat"
                pesan="Setoran muncul di sini setelah dibukukan petugas. Bila Anda sudah menyetor hari ini, pencatatannya bisa menyusul."
              />
            ) : (
              <TabelSetoran baris={data.data} />
            )
          }
        </Muat>
      </KartuMitra>
    </HalamanMitra>
  );
}

function TabelJadwal({ baris }: { baris: readonly BarisJadwalMitra[] }) {
  return (
    <>
      <div className="mitra-tabel-bungkus">
        <table className="mitra-tabel">
          <caption className="mitra-tabel-caption">Jadwal angsuran akad ini</caption>
          <thead>
            <tr>
              <th scope="col">Ke</th>
              <th scope="col">Jatuh tempo</th>
              <th scope="col" className="is-numeric">Pokok</th>
              <th scope="col" className="is-numeric">Jasa adm</th>
              <th scope="col" className="is-numeric">Total</th>
              <th scope="col" className="is-numeric">Terbayar</th>
              <th scope="col">Keadaan</th>
            </tr>
          </thead>
          <tbody>
            {baris.map((row) => (
              <tr key={row.angsuranKe}>
                <td className="is-numeric">{row.angsuranKe}</td>
                <td>{formatDate(row.tanggalJatuhTempo)}</td>
                <td className="is-numeric angka">{formatRupiah(row.pokok)}</td>
                <td className="is-numeric angka">{formatRupiah(row.jasaAdm)}</td>
                <td className="is-numeric angka">{formatRupiah(row.total)}</td>
                <td className="is-numeric angka">
                  {formatRupiah(row.pokokTerbayar)}
                  <span className="mitra-sub-angka">jasa {formatRupiah(row.jasaTerbayar)}</span>
                </td>
                <td>
                  <StatusBadge
                    status={LABEL_BARIS[row.status] ?? row.status}
                    tone={NADA_BARIS[row.status] ?? "neutral"}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="mitra-baris-list">
        {baris.map((row) => (
          <li className="mitra-baris-item" key={row.angsuranKe}>
            <article className="mitra-baris-kartu">
              <header className="mitra-baris-head">
                <span className="mitra-baris-judul">Angsuran ke {row.angsuranKe}</span>
                <StatusBadge
                  status={LABEL_BARIS[row.status] ?? row.status}
                  tone={NADA_BARIS[row.status] ?? "neutral"}
                />
              </header>
              <p className="mitra-baris-sub">Jatuh tempo {formatDate(row.tanggalJatuhTempo)}</p>
              <p className="mitra-baris-meta">
                Pokok {formatRupiah(row.pokok)}, jasa {formatRupiah(row.jasaAdm)}
              </p>
              <p className="mitra-baris-nilai">
                <span className="mitra-baris-nilai-label">Total angsuran</span>
                <span className="mitra-baris-nilai-val angka">{formatRupiah(row.total)}</span>
              </p>
            </article>
          </li>
        ))}
      </ul>
    </>
  );
}

function TabelSetoran({ baris }: { baris: readonly PembayaranMitra[] }) {
  return (
    <>
      <div className="mitra-tabel-bungkus">
        <table className="mitra-tabel">
          <caption className="mitra-tabel-caption">Setoran yang tercatat pada akad ini</caption>
          <thead>
            <tr>
              <th scope="col">Tanggal</th>
              <th scope="col" className="is-numeric">Diterima</th>
              <th scope="col" className="is-numeric">Ke pokok</th>
              <th scope="col" className="is-numeric">Ke jasa</th>
              <th scope="col" className="is-numeric">Kelebihan</th>
              <th scope="col">No bukti</th>
            </tr>
          </thead>
          <tbody>
            {baris.map((row, index) => (
              <tr key={`${row.tanggalTerima}-${row.noBukti ?? index}`}>
                <td>{formatDate(row.tanggalTerima)}</td>
                <td className="is-numeric angka">{formatRupiah(row.jumlahDiterima)}</td>
                <td className="is-numeric angka">{formatRupiah(row.alokasiPokok)}</td>
                <td className="is-numeric angka">{formatRupiah(row.alokasiJasa)}</td>
                <td className="is-numeric angka">{formatRupiah(row.alokasiKelebihan)}</td>
                {/* An ABSENT receipt number is not an unreadable one. It is
                    printed as words, never through a formatter, and never as a
                    blank cell that would read as a missing figure. */}
                <td>{row.noBukti ?? <span className="mitra-kosong-nilai">Tanpa nomor bukti</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="mitra-baris-list">
        {baris.map((row, index) => (
          <li className="mitra-baris-item" key={`${row.tanggalTerima}-${row.noBukti ?? index}`}>
            <article className="mitra-baris-kartu">
              <header className="mitra-baris-head">
                <span className="mitra-baris-judul">Setoran {formatDate(row.tanggalTerima)}</span>
              </header>
              <p className="mitra-baris-sub">
                {row.noBukti ?? "Tanpa nomor bukti"}
              </p>
              <p className="mitra-baris-meta">
                Ke pokok {formatRupiah(row.alokasiPokok)}, ke jasa {formatRupiah(row.alokasiJasa)}
              </p>
              <p className="mitra-baris-nilai">
                <span className="mitra-baris-nilai-label">Diterima</span>
                <span className="mitra-baris-nilai-val angka">
                  {formatRupiah(row.jumlahDiterima)}
                </span>
              </p>
            </article>
          </li>
        ))}
      </ul>
    </>
  );
}

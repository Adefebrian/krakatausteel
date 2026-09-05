// The mitra's landing screen: who they are, and where their obligations stand
// right now.
//
// EVERY FIGURE HERE IS A SUM OF FIGURES THE SERVER SENT, computed with
// packages/ui's `jumlahkanUang`, which adds decimal STRINGS in integer cents.
// Not with `+` on parsed floats: the columns are NUMERIC(20,2), and a float
// round trip is exactly how a rupiah total ends in ,99. When a value in the
// list cannot be read at all, `jumlahkanUang` returns null and the tile prints
// the marker rather than a total that silently dropped a contract.
//
// AND NOTHING HERE IS A SECOND OPINION ABOUT A CONTRACT. The tiles total what
// the akad list shows; they do not recompute a balance, a rate or an arrears
// figure. There is one place those are decided, and it is not a landing screen.
import { formatRupiah, jumlahkanUang, UNPARSEABLE } from "@krakatausteel/ui";
import { daftarAkad, type AkadMitra } from "../api/mitra";
import { useRouter } from "../router";
import { HalamanMitra, KartuMitra } from "./MitraApp";
import { StatusAkad } from "./AkadList";
import { KosongMitra, Muat, useMuatMitra } from "./pemuat";
import { useSesiMitra } from "./sesi";

export function BerandaMitra() {
  const { profil } = useSesiMitra();
  const hasil = useMuatMitra(() => daftarAkad(), []);
  const { navigate } = useRouter();

  return (
    <HalamanMitra
      judul={`Halo, ${profil?.namaLengkap ?? "Mitra Binaan"}`}
      ringkas="Ringkasan akad dan kewajiban Anda pada saat ini."
    >
      <KartuMitra judul="Identitas Anda">
        <dl className="mitra-ringkas">
          <div className="mitra-ringkas-item">
            <dt>Kode mitra</dt>
            <dd>{profil?.kodeMitra ?? ""}</dd>
          </div>
          <div className="mitra-ringkas-item">
            <dt>Nama usaha</dt>
            <dd>{profil?.namaUsaha ?? <span className="mitra-kosong-nilai">Belum tercatat</span>}</dd>
          </div>
          <div className="mitra-ringkas-item">
            <dt>Cabang pembina</dt>
            <dd>
              {profil ? `${profil.cabang.kode} ${profil.cabang.nama}` : ""}
            </dd>
          </div>
        </dl>
      </KartuMitra>

      <Muat hasil={hasil} judul="ringkasan akad Anda">
        {(data) => <Ringkasan akad={data.data} buka={() => navigate("/mitra/akad")} />}
      </Muat>
    </HalamanMitra>
  );
}

function Ringkasan({ akad, buka }: { akad: readonly AkadMitra[]; buka: () => void }) {
  if (akad.length === 0) {
    return (
      <KartuMitra judul="Kewajiban Anda">
        <KosongMitra
          judul="Belum ada akad atas nama Anda"
          pesan="Ringkasan kewajiban muncul di sini setelah akad pertama Anda tercatat."
        />
      </KartuMitra>
    );
  }

  const berjalan = akad.filter((a) => a.status !== "LUNAS");
  const totalPokok = jumlahkanUang(akad.map((a) => a.outstandingPokok));
  const totalJasa = jumlahkanUang(akad.map((a) => a.outstandingJasa));

  return (
    <>
      <KartuMitra
        judul="Kewajiban Anda"
        ringkas={`Dijumlahkan dari ${akad.length} akad, termasuk yang sudah lunas.`}
      >
        <div className="mitra-angka-grid">
          <div className="mitra-angka">
            <span className="mitra-angka-label">Sisa pokok</span>
            <span className="mitra-angka-nilai angka">
              {totalPokok === null ? UNPARSEABLE : formatRupiah(totalPokok)}
            </span>
          </div>
          <div className="mitra-angka">
            <span className="mitra-angka-label">Sisa jasa administrasi</span>
            <span className="mitra-angka-nilai angka">
              {totalJasa === null ? UNPARSEABLE : formatRupiah(totalJasa)}
            </span>
          </div>
          <div className="mitra-angka">
            <span className="mitra-angka-label">Akad berjalan</span>
            <span className="mitra-angka-nilai angka">{berjalan.length}</span>
          </div>
        </div>
      </KartuMitra>

      <KartuMitra
        judul="Akad terakhir Anda"
        ringkas="Tiga akad terbaru. Selebihnya ada di halaman Akad."
        footer={
          <button type="button" className="mitra-btn is-utama" onClick={buka}>
            Lihat semua akad
          </button>
        }
      >
        <ul className="mitra-ringkas-list">
          {[...akad]
            .sort((a, b) => b.tanggalAkad.localeCompare(a.tanggalAkad))
            .slice(0, 3)
            .map((a) => (
              <li className="mitra-ringkas-baris" key={a.id}>
                <span className="mitra-ringkas-baris-no">{a.noAkad}</span>
                <StatusAkad status={a.status} />
                <span className="mitra-ringkas-baris-nilai angka">
                  {formatRupiah(a.outstandingPokok)}
                </span>
              </li>
            ))}
        </ul>
      </KartuMitra>
    </>
  );
}

// Cek Integritas Data, spec 9.6. The health check page for the invariants the
// database and the closing engine are supposed to keep.
//
// IT DIAGNOSES AND NEVER REPAIRS. `GET /api/tools/integritas` is the only call
// this screen makes, the engine behind it has no journal port, and there is no
// control here that changes a record. That is deliberate down to the wording of
// the note at the foot: a repair invented on a health check page would be a
// second way into the ledger, around `postingEvent`.
//
// NINE CHECKS, ALL NINE, EVERY TIME, in the catalogue's own order, each with
// its verdict, its count and the offending rows WITH THEIR IDS. A page that
// says "3 failures" without saying which rows is a page nobody can act on.
//
// AND TWO OF THEM CANNOT FAIL, WHICH THE PAGE SAYS OUT LOUD. `dijagaDatabase`
// marks the checks a database constraint already makes impossible to break;
// their permanently green row is expected rather than suspicious, and an
// operator should not have to guess that.
import { Bento, BentoItem, Icon, Panel, formatCount, formatDate } from "@krakatausteel/ui";
import { jalankanIntegritas } from "../../api/tools";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useActiveSession } from "../../session";
import {
  CatatanOtorisasi,
  HalamanModul,
  Muat,
  Penyaring,
  useLayarKecil,
  useLingkupCabang,
} from "../shared/parts";
import { CatatanDiagnosa, ItemPemeriksaan, KartuRingkas } from "./parts";

export function Integritas({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const kecil = useLayarKecil();
  const lingkup = useLingkupCabang("Cabang yang diperiksa");

  const laporan = useApi(
    () => jalankanIntegritas({ cabangId: lingkup.cabangId }),
    [lingkup.cabangId],
  );

  const isiFilter = (
    <div className="filter-laporan">
      {lingkup.kontrol}
      <p className="filter-laporan-catatan">
        Cabang di sini mempersempit populasi baris yang diperiksa, bukan aturan pemeriksaannya.
        Cabang di luar wewenang sesi Anda ditolak server, bukan dijawab dengan hasil kosong.
      </p>
    </div>
  );

  return (
    <HalamanModul route={route}>
      {kecil ? <Penyaring ringkas={lingkup.ringkas}>{isiFilter}</Penyaring> : isiFilter}

      <Muat hasil={laporan} judul="hasil cek integritas" sumber="GET /api/tools/integritas">
        {(data) => {
          const gagal = data.hasil.filter((h) => !h.lulus);
          const namaCabang = data.cabangDiperiksa
            .map(
              (id) =>
                session.cabangTersedia.find((c) => c.id === id)?.nama ?? "cabang di luar daftar",
            )
            .join(", ");
          return (
            <>
              <Bento columns={4}>
                <BentoItem span="sm">
                  <KartuRingkas
                    judul="Kondisi keseluruhan"
                    nilai={data.sehat ? "Sehat" : "Ada temuan"}
                    catatan={
                      data.sehat
                        ? "Seluruh pemeriksaan lolos pada lingkup yang dipilih."
                        : "Setidaknya satu pemeriksaan menemukan baris yang melanggar invariannya."
                    }
                  />
                </BentoItem>
                <BentoItem span="sm">
                  <KartuRingkas
                    judul="Pemeriksaan tidak lolos"
                    nilai={`${formatCount(gagal.length)} dari ${formatCount(data.hasil.length)}`}
                    catatan="Seluruh pemeriksaan selalu dijalankan dan selalu ditampilkan, termasuk yang lolos."
                  />
                </BentoItem>
                <BentoItem span="sm">
                  <KartuRingkas
                    judul="Cabang diperiksa"
                    nilai={
                      data.cabangDiperiksa.length === 0
                        ? "Seluruh entitas"
                        : formatCount(data.cabangDiperiksa.length)
                    }
                    catatan={
                      data.cabangDiperiksa.length === 0
                        ? "Tidak ada penyempitan cabang, jadi seluruh cabang dalam entitas ikut diperiksa."
                        : `Lingkup pemeriksaan: ${namaCabang}.`
                    }
                  />
                </BentoItem>
                <BentoItem span="sm">
                  <KartuRingkas
                    judul="Tanggal pemeriksaan"
                    nilai={formatDate(data.dijalankanPada)}
                    catatan="Pemeriksaan dijalankan saat halaman ini dimuat. Tidak ada hasil yang disimpan atau di-cache."
                  />
                </BentoItem>
              </Bento>

              <Panel
                as="h2"
                title="Daftar pemeriksaan"
                description="Urutan katalog, sama dengan urutan yang dipakai pemeriksa seed, supaya kedua tempat itu terbaca sama."
                footer={
                  <span className="panel-foot-note">
                    Sumber: GET /api/tools/integritas. Kewenangan tools.integritas.
                  </span>
                }
              >
                <ol className="prasyarat-list">
                  {data.hasil.map((hasil) => (
                    <ItemPemeriksaan hasil={hasil} key={hasil.kode} />
                  ))}
                </ol>
              </Panel>

              {gagal.length === 0 ? null : (
                <p className="page-note">
                  <Icon name="alert" size={16} />
                  <span>
                    Temuan di halaman ini menahan closing periode ketika prasyarat yang sama
                    diperiksa ulang di modul closing. Perbaiki di modul pemilik datanya, lalu muat
                    ulang halaman ini untuk memeriksa kembali.
                  </span>
                </p>
              )}
            </>
          );
        }}
      </Muat>

      <CatatanDiagnosa />
      <CatatanOtorisasi tambahan="Halaman ini memerlukan kewenangan tools.integritas." />
    </HalamanModul>
  );
}

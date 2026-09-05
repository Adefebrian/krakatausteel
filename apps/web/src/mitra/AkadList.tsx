// The mitra's own akad, all of them, in one fixed shape per card.
//
// A CARD IS A FIXED SHAPE. Every card carries the same five things in the same
// places: the contract number, the date, the status, the outstanding figure and
// the one link onward. A contract with a long number and one with a short one
// produce the same card, so a list of six reads as one list rather than six
// designs. The outstanding figure is pinned to the bottom of the card, so the
// eye can run down the column that matters without re-finding it on each row.
//
// EVERY RUPIAH FIGURE GOES THROUGH packages/ui's formatter. None is composed
// here, and an ABSENT date is printed as words rather than sent through a
// formatter that would call it unreadable: an akad that is not yet settled has
// NO settlement date, and that is a fact about the contract, not a fault.
import { Icon, StatusBadge, formatDate, formatRupiah, type BadgeTone } from "@krakatausteel/ui";
import { daftarAkad, type AkadMitra } from "../api/mitra";
import { useRouter } from "../router";
import { HalamanMitra, KartuMitra } from "./MitraApp";
import { KosongMitra, Muat, useMuatMitra } from "./pemuat";

/**
 * The status vocabulary of `pumk_akad.status`, in words a borrower reads, and
 * the tone each carries. An unmapped status falls back to the server's own
 * value with a neutral tone rather than being hidden: a status this build has
 * never seen is still the truth about the contract.
 */
const LABEL_STATUS: Readonly<Record<string, string>> = {
  AKTIF: "Berjalan",
  LUNAS: "Lunas",
  MACET: "Menunggak",
  DIHAPUSBUKUKAN: "Dihapusbukukan",
  DIRESCHEDULE: "Dijadwalkan ulang",
  DIAKHIRI: "Diakhiri",
};

const NADA_STATUS: Readonly<Record<string, BadgeTone>> = {
  AKTIF: "info",
  LUNAS: "success",
  MACET: "danger",
  DIHAPUSBUKUKAN: "neutral",
  DIRESCHEDULE: "warning",
  DIAKHIRI: "neutral",
};

export function StatusAkad({ status }: { status: string }) {
  return <StatusBadge status={LABEL_STATUS[status] ?? status} tone={NADA_STATUS[status] ?? "neutral"} />;
}

export function AkadMitraList() {
  const hasil = useMuatMitra(() => daftarAkad(), []);
  return (
    <HalamanMitra
      judul="Akad Saya"
      ringkas="Seluruh akad pendanaan atas nama Anda, beserta sisa kewajiban masing masing."
    >
      <Muat hasil={hasil} judul="daftar akad Anda">
        {(data) =>
          data.data.length === 0 ? (
            <KartuMitra judul="Belum ada akad">
              <KosongMitra
                judul="Belum ada akad atas nama Anda"
                pesan="Bila Anda baru saja menandatangani akad, datanya akan muncul di sini setelah petugas mencatatnya."
              />
            </KartuMitra>
          ) : (
            <ul className="mitra-akad-list">
              {data.data.map((akad) => (
                <KartuAkad akad={akad} key={akad.id} />
              ))}
            </ul>
          )
        }
      </Muat>
    </HalamanMitra>
  );
}

function KartuAkad({ akad }: { akad: AkadMitra }) {
  const { navigate } = useRouter();
  return (
    <li className="mitra-akad-item">
      <article className="mitra-akad-kartu">
        <header className="mitra-akad-head">
          <span className="mitra-akad-no">{akad.noAkad}</span>
          <StatusAkad status={akad.status} />
        </header>

        <dl className="mitra-akad-fakta">
          <div className="mitra-akad-fakta-item">
            <dt>Tanggal akad</dt>
            <dd>{formatDate(akad.tanggalAkad)}</dd>
          </div>
          <div className="mitra-akad-fakta-item">
            <dt>Pokok pinjaman</dt>
            <dd className="angka">{formatRupiah(akad.pokokPinjaman)}</dd>
          </div>
          <div className="mitra-akad-fakta-item">
            <dt>Tenor</dt>
            <dd>{akad.tenorBulan} bulan</dd>
          </div>
          <div className="mitra-akad-fakta-item">
            <dt>Jatuh tempo akhir</dt>
            <dd>{formatDate(akad.tanggalJatuhTempoAkhir)}</dd>
          </div>
        </dl>

        <div className="mitra-akad-sisa">
          <span className="mitra-akad-sisa-label">Sisa pokok</span>
          <span className="mitra-akad-sisa-nilai angka">{formatRupiah(akad.outstandingPokok)}</span>
          <span className="mitra-akad-sisa-label">Sisa jasa administrasi</span>
          <span className="mitra-akad-sisa-nilai angka">{formatRupiah(akad.outstandingJasa)}</span>
        </div>

        <button
          type="button"
          className="mitra-akad-buka"
          onClick={() => navigate(`/mitra/akad/${akad.id}`)}
        >
          <span>Lihat jadwal dan setoran</span>
          <Icon name="chevronRight" size={16} />
        </button>
      </article>
    </li>
  );
}

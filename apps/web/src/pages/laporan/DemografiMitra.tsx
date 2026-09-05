// 27. Laporan Demografi Mitra Binaan.
//
// IT DOES NOT COME THROUGH ./generik.tsx BECAUSE IT IS NOT ONE LIST. The
// engine answers SEVEN independent distributions over the same population, and
// the generic driver draws one table with one footing. Flattening seven
// distributions into a single table with a "dimensi" column would have made a
// reader add up rows that must never be added up: every distribution already
// sums to the whole population, so a total row across all seven would be seven
// times the number of partners.
//
// SO EACH DISTRIBUTION IS ITS OWN CARD IN A BENTO GRID, and every card is the
// SAME SHAPE: a title, the number of partners it accounts for, then the
// buckets, in that order, always. A row of cards is stretched to its tallest
// member by the grid, so the bottom edges line up without any card being
// given a height of its own.
//
// AND NOTHING IS CLIPPED TO ACHIEVE THAT. The first version DID pin a height
// and scroll the bucket list inside it, and the result was a report about a
// population that quietly hid two of its groups below the fold of their own
// card. A number a reader cannot see is worse than a row of cards that are not
// all the same height.
//
// SPEC 10.4 ASKS FOR "visualisasi". The bar here is drawn from the SERVER'S
// OWN `persen`, never from a ratio this screen computes: a bar whose length
// disagreed with the percentage printed beside it would be a second opinion
// about the same figure. When the server sends no percentage (a distribution
// over an empty population), the bar is absent and the words say why, because
// an absent share is not a zero share.
import { Icon, Panel, formatCount } from "@krakatausteel/ui";
import {
  demografiMitra,
  type DistribusiDemografi,
  type EmberDemografi,
  type LaporanDemografiMitra,
} from "../../api/laporan-operasional";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { HalamanLaporan, KopLaporan, NilaiPersen, useFilterLaporan } from "./parts";

/**
 * One bucket. The bar is decoration ON TOP of the figures and never instead of
 * them: the count and the percentage are both printed as text, so a reader who
 * cannot see the bar loses nothing at all.
 */
function Ember({ ember }: { ember: EmberDemografi }) {
  const lebar = lebarBar(ember.persen);
  return (
    <li className="demografi-ember">
      <span className="demografi-ember-head">
        <span className="demografi-ember-nama">{ember.nama}</span>
        <span className="demografi-ember-cacah">{formatCount(ember.jumlah)}</span>
      </span>
      <span className="demografi-ember-bar" aria-hidden="true">
        {lebar === null ? null : (
          <span className="demografi-ember-isi" style={{ width: `${lebar}%` }} />
        )}
      </span>
      <span className="demografi-ember-persen">
        <NilaiPersen nilai={ember.persen} />
      </span>
    </li>
  );
}

/**
 * The bar's width, or null when there is no share to draw.
 *
 * Clamped to 0..100 rather than trusted: a share above 100 is a server fault,
 * and a bar that ran outside its own card would hide the fault behind a layout
 * bug instead of leaving the printed percentage to say it.
 */
function lebarBar(persen: string | null): number | null {
  if (persen === null) return null;
  const nilai = Number(persen);
  if (!Number.isFinite(nilai)) return null;
  return Math.min(100, Math.max(0, nilai));
}

function KartuDistribusi({ distribusi }: { distribusi: DistribusiDemografi }) {
  const terisi = distribusi.ember.reduce((jumlah, e) => jumlah + e.jumlah, 0);
  return (
    <article className="demografi-kartu">
      <header className="demografi-kartu-head">
        <h3 className="demografi-kartu-judul">{distribusi.nama}</h3>
        <p className="demografi-kartu-sub">
          {formatCount(terisi)} mitra pada {formatCount(distribusi.ember.length)} kelompok
        </p>
      </header>
      {distribusi.ember.length === 0 ? (
        <p className="demografi-kosong">
          Tidak ada mitra yang bisa dikelompokkan pada dimensi ini untuk periode dan cabang yang
          dipilih.
        </p>
      ) : (
        <ul className="demografi-ember-list">
          {distribusi.ember.map((ember) => (
            <Ember ember={ember} key={ember.kode} />
          ))}
        </ul>
      )}
    </article>
  );
}

/** What each `DasarWilayah` means, in the words a reader of the page needs. */
const LABEL_DASAR: Readonly<Record<string, string>> = {
  ALAMAT_MITRA_SAAT_INI: "Alamat mitra saat ini",
};

export function DemografiMitraPage({ route }: { route: PageRoute }) {
  const filter = useFilterLaporan();

  const hasil = useApi(
    () => demografiMitra({ periodeId: filter.periodeId ?? "", cabangId: filter.cabangId }),
    [filter.periodeId, filter.cabangId],
    { enabled: filter.siap && filter.periodeId !== null },
  );

  return (
    <HalamanLaporan
      route={route}
      filter={filter}
      hasil={hasil}
      judul="laporan demografi mitra binaan"
      sumber="GET /api/laporan/demografi-mitra"
      crumb="Laporan Lainnya"
    >
      {(data: LaporanDemografiMitra) => (
        <>
          <KopLaporan header={data.header} />

          <Panel
            as="h2"
            title="Populasi yang dianalisis"
            description="Setiap distribusi di bawah menghitung populasi yang sama, jadi angkanya tidak boleh dijumlahkan antar distribusi."
          >
            <ul className="ringkas-angka">
              <li className="ringkas-angka-item">
                <span className="ringkas-angka-label">Mitra Binaan</span>
                <span className="ringkas-angka-baris">
                  <span className="ringkas-angka-key">Jumlah</span>
                  <span className="angka">{formatCount(data.jumlahMitra)}</span>
                </span>
              </li>
              <li className="ringkas-angka-item">
                <span className="ringkas-angka-label">Distribusi</span>
                <span className="ringkas-angka-baris">
                  <span className="ringkas-angka-key">Dimensi</span>
                  <span className="angka">{formatCount(data.distribusi.length)}</span>
                </span>
              </li>
              {/* THE ADDRESS BASIS IS A FIGURE ON THIS PAGE, not a footnote.
                  A partner who moved carries their whole history to the new
                  province, so a reader comparing two years of this report has
                  to know which basis each was printed on. */}
              <li className="ringkas-angka-item">
                <span className="ringkas-angka-label">Dasar wilayah</span>
                <span className="ringkas-angka-baris">
                  <span className="ringkas-angka-key">Alamat</span>
                  <span>{LABEL_DASAR[data.dasarWilayah] ?? data.dasarWilayah}</span>
                </span>
              </li>
            </ul>
          </Panel>

          <Panel
            as="h2"
            title="Distribusi demografi"
            description={`${data.distribusi.length} dimensi, masing masing atas ${formatCount(data.jumlahMitra)} Mitra Binaan yang sama.`}
          >
            <div className="demografi-grid">
              {data.distribusi.map((distribusi) => (
                <KartuDistribusi distribusi={distribusi} key={distribusi.dimensi} />
              ))}
            </div>
          </Panel>

          <p className="page-note">
            <Icon name="info" size={16} />
            <span>
              Dimensi wilayah memakai alamat Mitra Binaan yang tercatat saat ini, bukan alamat
              pada saat akad ditandatangani, sehingga mitra yang pindah terhitung di wilayah
              barunya. Mitra yang datanya belum terisi masuk ke kelompok Tidak diketahui pada
              dimensi yang bersangkutan, bukan dihilangkan dari populasi.
            </span>
          </p>
        </>
      )}
    </HalamanLaporan>
  );
}

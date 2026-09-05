// Antrean Tinjauan Anomali Jurnal, spec 12 priority 2.
//
// WHAT THIS PAGE IS, SAID IN THE ONE WAY THAT MATTERS: A READING ORDER. It
// ranks the posted journals of one period by how much each deserves a second
// look, and it refuses nothing. A flagged journal is a valid journal, the
// closing checklist does not consult this engine, and no approval anywhere
// reads what it produced. Every wording on this page is chosen so a reviewer
// cannot mistake a score for a verdict.
//
// FIVE THINGS THIS SCREEN HAS TO KEEP TRUE:
//
//   THE SCORE IS A SUM OF PUBLISHED WEIGHTS, NOT A MODEL'S OPINION. This half
//   of the assistant calls no model at all. The rule catalogue is loaded and
//   shown BEFORE any scan, weights included, so the arithmetic behind an order
//   is legible rather than trusted.
//
//   EVERY FINDING SHOWS THE NUMBERS IT FIRED ON. `dasar` is spec 12's "dasar
//   perhitungan atau sumber data secara eksplisit", and it is printed on the
//   finding rather than hidden behind a drill down, because a reviewer decides
//   whether to open a journal from exactly those numbers.
//
//   OFF IS NOT CLEAN. With the flag off the endpoint answers 200 with
//   `aktif: false` and an empty queue, and an empty queue reads as "these books
//   are tidy". That would be a wrong answer presented as a right one, so the
//   off state is rendered as its own panel and the queue is NOT drawn at all.
//   Same reason the engine refuses a branch outside scope instead of returning
//   an empty list.
//
//   THE BRANCH IS A FILTER, NEVER AUTHORITY. The picker offers only branches
//   the SESSION resolved; a branch outside that set is refused by the engine.
//
//   MONEY GOES THROUGH packages/ui. `totalDebit` is a NUMERIC(20,2) string and
//   a `dasar` entry that is null is ABSENT, printed as "tidak ada" and never
//   sent through the money formatter.
//
// ONE ENDPOINT THIS PAGE BORROWS. `GET /ai/anomali` requires a `periodeId` and
// the assistant module ships no period list of its own, so the picker reads
// `GET /laporan/periode`, which is gated on `laporan.view`. Every role that
// holds `ai.anomali` also holds `laporan.view`, so that is sound today; it is
// still a cross module read and it is named here rather than buried.
import { useMemo } from "react";
import {
  Bento,
  BentoItem,
  Icon,
  Panel,
  Select,
  StatusBadge,
  formatCount,
  formatDate,
  formatPeriode,
} from "@krakatausteel/ui";
import {
  deteksiAnomali,
  katalogAnomali,
  statusAi,
  type JurnalDitandai,
  type LaporanAnomali,
  type TemuanAnomali,
} from "../../api/ai";
import { periodeLaporan } from "../../api/laporan";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useRouter } from "../../router";
import { useActiveSession } from "../../session";
import {
  CatatanOtorisasi,
  HalamanModul,
  Muat,
  Penyaring,
  useLayarKecil,
  useLingkupCabang,
} from "../shared/parts";
import {
  AsistenMati,
  CatatanAsisten,
  DaftarFakta,
  JUDUL_ANOMALI,
  KartuRingkas,
  labelDasar,
  nilaiDasar,
  teksUang,
} from "./parts";

export function AntreanAnomali({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const kecil = useLayarKecil();
  const { query, setQuery } = useRouter();
  const lingkup = useLingkupCabang("Cabang yang ditinjau");

  const status = useApi(() => statusAi(), []);
  const aktif = status.data?.aktif === true && status.data.kemampuan.deteksiAnomali;

  // NOT FETCHED WHILE THE LAYER IS OFF. The period list exists to drive a scan,
  // and with the flag off there is no scan to drive, so asking for it would be
  // a request made to fill a control this page is about to decide not to draw.
  const periode = useApi(() => periodeLaporan(), [], { enabled: aktif });

  const daftarPeriode = periode.data?.data ?? [];
  const periodeUrl = query.get("periode");
  const periodeId = useMemo(() => {
    if (periodeUrl && daftarPeriode.some((p) => p.id === periodeUrl)) return periodeUrl;
    return daftarPeriode[0]?.id ?? null;
  }, [periodeUrl, daftarPeriode]);
  const periodeTerpilih = daftarPeriode.find((p) => p.id === periodeId) ?? null;

  const laporan = useApi(
    () => deteksiAnomali({ periodeId: periodeId ?? "", cabangId: lingkup.cabangId }),
    [periodeId, lingkup.cabangId],
    { enabled: aktif && periodeId !== null },
  );

  const katalog = useApi(() => katalogAnomali(), []);

  const isiFilter = (
    <div className="filter-laporan">
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Periode</span>
        <Select
          aria-label="Periode yang ditinjau"
          value={periodeId ?? ""}
          disabled={daftarPeriode.length === 0}
          onChange={(event) => setQuery("periode", event.currentTarget.value)}
          options={
            daftarPeriode.length === 0
              ? [
                  {
                    value: "",
                    label:
                      periode.status === "memuat" ? "Memuat periode" : "Tidak ada periode",
                  },
                ]
              : daftarPeriode.map((p) => ({
                  value: p.id,
                  label: formatPeriode(p.tahun, p.bulan),
                }))
          }
        />
      </label>
      {lingkup.kontrol}
      <p className="filter-laporan-catatan">
        Antrean ini hanya membaca jurnal yang sudah diposting pada periode terpilih. Cabang di sini
        mempersempit populasi yang dibaca, bukan aturannya, dan cabang di luar wewenang sesi Anda
        ditolak server, bukan dijawab dengan antrean kosong.
      </p>
    </div>
  );

  const ringkasFilter = `${periodeTerpilih ? formatPeriode(periodeTerpilih.tahun, periodeTerpilih.bulan) : "Periode belum dipilih"}, ${lingkup.ringkas}`;

  return (
    <HalamanModul route={route}>
      {/*
        A CONTROL THAT CANNOT CHANGE ANYTHING IS NOT DRAWN. With the layer off
        the period and branch pickers sat above a panel saying no scan was run,
        so a reader could change a filter and watch nothing happen. They appear
        only once the assistant is on and there is a queue for them to narrow.
      */}
      {aktif
        ? kecil
          ? <Penyaring ringkas={ringkasFilter}>{isiFilter}</Penyaring>
          : isiFilter
        : null}

      <Muat hasil={status} judul="status asisten" sumber="GET /api/ai/status">
        {(data) =>
          data.aktif && data.kemampuan.deteksiAnomali ? (
            periodeId === null ? (
              <Muat hasil={periode} judul="daftar periode" sumber="GET /api/laporan/periode">
                {() => (
                  <Panel as="h2" title="Belum ada periode yang bisa ditinjau">
                    <p className="asisten-mati-kalimat">
                      Tidak ada periode akuntansi pada entitas ini, jadi belum ada jurnal yang bisa
                      diurutkan. Buat periode terlebih dahulu di Periode Akuntansi.
                    </p>
                  </Panel>
                )}
              </Muat>
            ) : (
              <Muat
                hasil={laporan}
                judul="antrean anomali"
                sumber="GET /api/ai/anomali"
                diamLabel="Pilih periode terlebih dahulu."
              >
                {(isi) => (
                  <Hasil
                    laporan={isi}
                    namaPeriode={
                      periodeTerpilih
                        ? formatPeriode(periodeTerpilih.tahun, periodeTerpilih.bulan)
                        : "periode terpilih"
                    }
                    namaCabang={(id) =>
                      session.cabangTersedia.find((c) => c.id === id)?.nama ??
                      "cabang di luar daftar"
                    }
                  />
                )}
              </Muat>
            )
          ) : (
            <AsistenMati
              judul="Antrean anomali sedang dimatikan"
              kalimat="Lapisan asisten tidak diaktifkan pada server ini, jadi tidak ada pemindaian yang dijalankan untuk periode mana pun."
              sebagaiGantinya="Tinjau jurnal lewat Daftar Jurnal dan Review Checker seperti biasa. Antrean kosong di halaman ini berarti pemindaian tidak dijalankan, bukan berarti tidak ada jurnal yang perlu ditinjau."
            />
          )
        }
      </Muat>

      <Muat hasil={katalog} judul="katalog aturan anomali" sumber="GET /api/ai/anomali/katalog">
        {(data) => (
          <Panel
            as="h2"
            title="Aturan dan bobotnya"
            description="Seluruh aturan yang dipakai, beserta bobot dan artefak yang dibacanya. Skor sebuah jurnal adalah jumlah bobot aturan yang menyala padanya, dihitung dengan bilangan bulat, tanpa model bahasa."
            footer={
              <span className="panel-foot-note">
                Sumber: GET /api/ai/anomali/katalog. Kewenangan ai.anomali.
              </span>
            }
          >
            <ul className="aturan-grid">
              {data.data.map((aturan) => (
                <li className="aturan-item" key={aturan.kode}>
                  <div className="aturan-head">
                    <span className="aturan-judul">
                      {JUDUL_ANOMALI[aturan.kode] ?? aturan.nama}
                    </span>
                    <span className="aturan-bobot">
                      <span className="aturan-bobot-label">Bobot</span>
                      <span className="aturan-bobot-val">{formatCount(aturan.bobot)}</span>
                    </span>
                  </div>
                  <p className="aturan-jelas">{aturan.penjelasan}</p>
                  <p className="aturan-sumber">Dibaca dari {aturan.sumber}.</p>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </Muat>

      <CatatanAsisten tambahan="Skor di halaman ini hanya menentukan urutan baca. Tidak ada jurnal yang ditahan, ditolak, atau dibatalkan karenanya." />
      <CatatanOtorisasi tambahan="Halaman ini memerlukan kewenangan ai.anomali." />
    </HalamanModul>
  );
}

function Hasil({
  laporan,
  namaPeriode,
  namaCabang,
}: {
  laporan: LaporanAnomali;
  namaPeriode: string;
  namaCabang: (id: string) => string;
}) {
  // OFF IS NOT CLEAN. See the file header: an empty queue drawn without this
  // branch reads as "these books are tidy", which is the wrong answer wearing
  // the clothes of a right one.
  if (!laporan.aktif) {
    return (
      <AsistenMati
        judul="Pemindaian tidak dijalankan"
        kalimat={`Lapisan asisten dimatikan, jadi periode ${namaPeriode} tidak dipindai sama sekali.`}
        sebagaiGantinya="Antrean di bawah sengaja tidak ditampilkan. Daftar kosong akan terbaca sebagai buku yang bersih, dan itu bukan yang diketahui halaman ini."
      />
    );
  }

  const skorTertinggi = laporan.jurnal[0]?.skor ?? 0;

  return (
    <>
      <Bento columns={4}>
        <BentoItem span="sm">
          <KartuRingkas
            judul="Jurnal diperiksa"
            nilai={formatCount(laporan.jumlahJurnalDiperiksa)}
            catatan={`Seluruh jurnal berstatus posted pada ${namaPeriode} dalam lingkup yang dipilih.`}
          />
        </BentoItem>
        <BentoItem span="sm">
          <KartuRingkas
            judul="Jurnal ditandai"
            nilai={formatCount(laporan.jumlahDitandai)}
            catatan="Ditandai berarti layak dibaca lebih dulu. Jurnal yang ditandai tetap jurnal yang sah."
          />
        </BentoItem>
        <BentoItem span="sm">
          <KartuRingkas
            judul="Skor tertinggi"
            nilai={formatCount(skorTertinggi)}
            catatan="Jumlah bobot aturan yang menyala pada satu jurnal. Urutan baca, bukan probabilitas dan bukan vonis."
          />
        </BentoItem>
        <BentoItem span="sm">
          <KartuRingkas
            judul="Cabang diperiksa"
            nilai={
              laporan.cabangDiperiksa.length === 0
                ? "Seluruh entitas"
                : formatCount(laporan.cabangDiperiksa.length)
            }
            catatan={
              laporan.cabangDiperiksa.length === 0
                ? "Tidak ada penyempitan cabang pada pemindaian ini."
                : `Lingkup pemindaian: ${laporan.cabangDiperiksa.map(namaCabang).join(", ")}.`
            }
          />
        </BentoItem>
      </Bento>

      <Panel
        as="h2"
        title="Urutan tinjauan"
        description="Diurutkan dari skor tertinggi. Bacalah dari atas; tidak ada satu pun baris di sini yang menahan posting, persetujuan, atau closing."
        aside={
          <StatusBadge
            status={laporan.hanyaSaran ? "HANYA_SARAN" : "MENGIKAT"}
            tone={laporan.hanyaSaran ? "info" : "warning"}
            label={laporan.hanyaSaran ? "Saran, tidak mengikat" : "Mengikat"}
          />
        }
        footer={
          <span className="panel-foot-note">
            Sumber: GET /api/ai/anomali. Dipindai {formatDate(laporan.dijalankanPada)}, tanpa
            model bahasa: seluruh aturan dihitung dari data.
          </span>
        }
      >
        {laporan.jurnal.length === 0 ? (
          <p className="asisten-mati-kalimat">
            Pemindaian berjalan dan tidak ada jurnal yang menyalakan satu aturan pun pada lingkup
            ini. Ini hasil pemindaian yang benar benar dijalankan, bukan pemindaian yang dilewati.
          </p>
        ) : (
          <ol className="anomali-list">
            {laporan.jurnal.map((jurnal) => (
              <ItemJurnal jurnal={jurnal} key={jurnal.jurnalId} namaCabang={namaCabang} />
            ))}
          </ol>
        )}
        {laporan.terpotong ? (
          <p className="rincian-potong">
            Daftar dipotong server. {formatCount(laporan.jumlahDitandai)} jurnal ditandai dan hanya
            sebagian yang dikirim. Persempit cabang untuk melihat sisanya.
          </p>
        ) : null}
      </Panel>
    </>
  );
}

/**
 * ONE SHAPE FOR EVERY FLAGGED JOURNAL.
 *
 * Head row with the journal number, the branch and the score; one meta line;
 * the total; then the findings, each with its own weight and the numbers it
 * fired on. The keterangan is clamped so a long free text description cannot
 * reshape one row against its neighbours.
 */
function ItemJurnal({
  jurnal,
  namaCabang,
}: {
  jurnal: JurnalDitandai;
  namaCabang: (id: string) => string;
}) {
  return (
    <li className="anomali-item">
      <div className="anomali-head">
        <span className="anomali-nomor">{jurnal.noJurnal}</span>
        <span className="anomali-skor">
          <span className="anomali-skor-label">Skor</span>
          <span className="anomali-skor-val">{formatCount(jurnal.skor)}</span>
        </span>
      </div>
      <p className="anomali-meta">
        {formatDate(jurnal.tanggalTransaksi)}, {jurnal.jenis}, {namaCabang(jurnal.cabangId)}
      </p>
      <p className="anomali-keterangan">
        {jurnal.keterangan === null || jurnal.keterangan.trim() === ""
          ? "Tanpa keterangan."
          : jurnal.keterangan}
      </p>
      <div className="anomali-total">
        <span className="anomali-total-label">Total debit</span>
        <span className="anomali-total-val angka">{teksUang(jurnal.totalDebit)}</span>
      </div>
      <ul className="temuan-list">
        {jurnal.temuan.map((temuan) => (
          <ItemTemuan temuan={temuan} key={temuan.kode} />
        ))}
      </ul>
      {/*
        SAID ONCE PER JOURNAL, NOT ONCE PER FINDING. It used to sit on every
        finding, so a journal with three rules firing carried the same sentence
        three times and the card read as nagging rather than as a fact. Caught
        by screenshot at 1440. Pinned to the foot of the card so the whole queue
        rests on one baseline.
      */}
      <p className="anomali-catatan">
        <Icon name="info" size={14} />
        <span>
          Temuan di atas menambah urutan baca saja. Jurnal ini tetap sah dan tetap terposting.
        </span>
      </p>
    </li>
  );
}

function ItemTemuan({ temuan }: { temuan: TemuanAnomali }) {
  const dasar = Object.entries(temuan.dasar).map(([kunci, nilai]) => ({
    kunci: labelDasar(kunci),
    nilai: nilaiDasar(kunci, nilai),
  }));
  return (
    <li className="temuan-item">
      <div className="temuan-head">
        <span className="temuan-judul">{JUDUL_ANOMALI[temuan.kode] ?? temuan.kode}</span>
        <span className="temuan-bobot">
          <span className="temuan-bobot-label">Bobot</span>
          <span className="temuan-bobot-val">{formatCount(temuan.bobot)}</span>
        </span>
      </div>
      <p className="temuan-alasan">{temuan.alasan}</p>
      <DaftarFakta items={dasar} />
    </li>
  );
}

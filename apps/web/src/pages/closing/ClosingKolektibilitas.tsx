// Closing Kolektibilitas, spec 8.1 and spec 9.3. The classification of every
// akad's receivable quality at the end of a month, the allowance each class
// requires, and the migration matrix the specification calls the thing
// accounting users value most.
//
// THE PREVIEW AND THE COMMITTED RUN ARE NEVER DRAWN THE SAME WAY. Spec 8.1
// makes preview mode mandatory, and the difference between the two is a whole
// month of snapshots. The server separated them by path, by status code and by
// a literal type; this screen keeps them apart on the page as well. A preview
// carries a standing notice saying nothing was written, its own heading, and no
// way to be mistaken for the stored figures, which stay one click away.
//
// THE RATE AND THE BASIS ARE SHOWN, NOT ASSUMED. Migrations 0024 and 0025 made
// the provenance explicit on every snapshot row precisely so it could be
// displayed: the rate ACTUALLY USED, the dasar perhitungan it was applied to,
// and whether it came from the configuration table or from a collective
// historical calculation. A later change to the rate table cannot move a closed
// month's figures, and this panel is where a reader sees which policy row
// produced the number in front of them.
//
// AN AUDITOR SEES EVERYTHING AND RUNS NOTHING. `admin.closing.view` reaches the
// stored snapshot and the run history; `admin.closing.kolektibilitas` is what
// the preview and the run need, and it is checked again on the server. Hiding a
// button is a convenience, never a control.
import { useState } from "react";
import {
  Bento,
  BentoItem,
  Button,
  ConfirmDialog,
  DataList,
  DataTable,
  Icon,
  StatusBadge,
  formatCount,
  formatDate,
  formatPeriode,
  formatTotal,
  type Column,
} from "@krakatausteel/ui";
import {
  jalankanKolektibilitas,
  pratinjauKolektibilitas,
  riwayatKolektibilitas,
  snapshotKolektibilitas,
  type BarisKolektibilitas,
  type HasilKolektibilitas,
  type OpsiPeriodeClosing,
  type PreviewKolektibilitas,
  type ReferensiClosing,
  type RingkasanKelas,
  type RiwayatRunKolektibilitas,
  type SelKematriks,
} from "../../api/closing";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useActiveSession } from "../../session";
import {
  AntreanKosong,
  CatatanOtorisasi,
  HalamanModul,
  Muat,
  Penyaring,
  useLayarKecil,
} from "../shared/parts";
import {
  asalRateDariBaris,
  HasilKosong,
  type AsalRate,
  LABEL_DASAR_PENYISIHAN,
  LABEL_KELAS,
  LABEL_MODE_PENYISIHAN,
  LABEL_SUMBER_RATE,
  matriksDariBaris,
  NilaiUang,
  PanelSumber,
  ringkasDariBaris,
  TanpaWewenang,
  teksRate,
  teksUang,
  URUTAN_KELAS,
  useKonteksClosing,
} from "./parts";

const LABEL_STATUS_RUN: Record<string, string> = {
  PREVIEW: "Pratinjau",
  SELESAI: "Selesai",
  GAGAL: "Gagal",
  DIBATALKAN: "Dibatalkan",
};

export function ClosingKolektibilitas({ route }: { route: PageRoute }) {
  const konteks = useKonteksClosing();
  const kecil = useLayarKecil();

  return (
    <HalamanModul route={route}>
      {kecil ? (
        <Penyaring ringkas={konteks.ringkas}>{konteks.kontrol}</Penyaring>
      ) : (
        konteks.kontrol
      )}

      <Muat hasil={konteks.referensi} judul="referensi closing" sumber="GET /api/closing/referensi">
        {(ref: ReferensiClosing) => (
          <Muat hasil={konteks.daftar} judul="daftar periode" sumber="GET /api/closing/periode">
            {() =>
              konteks.periode === null ? (
                <AntreanKosong
                  icon="calendar"
                  title="Belum ada periode akuntansi"
                  description="Belum ada satu periode pun pada entitas ini, jadi belum ada bulan yang bisa diklasifikasikan. Periode dibentuk lebih dulu pada konfigurasi tahun buku."
                />
              ) : (
                <Isi
                  key={`${konteks.periode.id}#${konteks.cabangId ?? "SEMUA"}`}
                  periode={konteks.periode}
                  cabangId={konteks.cabangId}
                  namaCabang={konteks.namaCabang}
                  referensi={ref}
                />
              )
            }
          </Muat>
        )}
      </Muat>

      <CatatanOtorisasi tambahan="Membaca hasil klasifikasi dan menjalankannya adalah dua kewenangan terpisah." />
    </HalamanModul>
  );
}

// ---------------------------------------------------------------------------
// One month, one scope
// ---------------------------------------------------------------------------

/**
 * What is on the screen, and where it came from.
 *
 * "TERSIMPAN" is the stored snapshot the reports read. "PRATINJAU" was computed
 * a moment ago and written nowhere. They are never merged and never shown at
 * the same time, because a reader who cannot tell which one is in front of them
 * cannot tell whether the month has been classified at all.
 */
type Asal = "TERSIMPAN" | "PRATINJAU" | "BARU_DIJALANKAN";

function Isi({
  periode,
  cabangId,
  namaCabang,
  referensi,
}: {
  periode: OpsiPeriodeClosing;
  cabangId: string | null;
  namaCabang: string;
  referensi: ReferensiClosing;
}) {
  const session = useActiveSession();
  const bolehJalankan = session.permissions.includes("admin.closing.kolektibilitas");

  const snapshot = useApi(
    () => snapshotKolektibilitas(periode.id, { cabangId }),
    [periode.id, cabangId],
  );
  const riwayat = useApi(() => riwayatKolektibilitas(periode.id), [periode.id]);

  const pratinjau = useAction<void, PreviewKolektibilitas>(() =>
    pratinjauKolektibilitas(periode.id, { cabangId }),
  );
  const jalankan = useAction<void, HasilKolektibilitas>(() =>
    jalankanKolektibilitas(periode.id, { cabangId }),
  );
  const [konfirmasi, setKonfirmasi] = useState(false);

  const hitung: PreviewKolektibilitas | HasilKolektibilitas | null =
    jalankan.hasil ?? pratinjau.hasil ?? null;
  const asal: Asal =
    jalankan.hasil !== null ? "BARU_DIJALANKAN" : pratinjau.hasil !== null ? "PRATINJAU" : "TERSIMPAN";

  const barisSnapshot = snapshot.data?.data ?? [];
  const baris: readonly BarisKolektibilitas[] = hitung ? hitung.baris : barisSnapshot;
  const ringkasan: readonly RingkasanKelas[] = hitung
    ? hitung.ringkasanPerKelas
    : ringkasDariBaris(barisSnapshot);
  const matriks: readonly SelKematriks[] = hitung ? hitung.matriks : matriksDariBaris(barisSnapshot);
  const asalRate = asalRateDariBaris(baris);

  const label = formatPeriode(periode.tahun, periode.bulan);
  const sumberAngka =
    asal === "TERSIMPAN"
      ? "GET /api/closing/periode/:id/kolektibilitas/snapshot"
      : asal === "PRATINJAU"
        ? "POST /api/closing/periode/:id/kolektibilitas/pratinjau"
        : "POST /api/closing/periode/:id/kolektibilitas";

  return (
    <>
      {bolehJalankan ? (
        <div className="closing-bar">
          <p className="closing-bar-teks">
            Pratinjau menghitung seluruh portofolio dan tidak menulis apa pun. Menjalankan menyimpan
            hasilnya dan menjadi dasar penyisihan serta akrual.
          </p>
          <div className="closing-aksi-row">
            <Button
              variant="secondary"
              loading={pratinjau.status === "mengirim"}
              disabled={periode.status !== "OPEN"}
              leading={<Icon name="eye" size={16} />}
              onClick={async () => {
                jalankan.reset();
                await pratinjau.jalankan(undefined);
              }}
            >
              Pratinjau tanpa menyimpan
            </Button>
            <Button
              variant="primary"
              disabled={periode.status !== "OPEN"}
              leading={<Icon name="refresh" size={16} />}
              onClick={() => setKonfirmasi(true)}
            >
              Jalankan dan simpan
            </Button>
          </div>
        </div>
      ) : null}

      {periode.status !== "OPEN" ? (
        <TanpaWewenang judul={`Periode ${label} tidak berstatus terbuka`}>
          Klasifikasi kolektibilitas hanya bisa dijalankan atas periode yang masih terbuka, karena
          angka periode tertutup sudah dibekukan. Hasil yang tersimpan tetap bisa dibaca di bawah
          sebagai bukti.
        </TanpaWewenang>
      ) : null}

      {asal === "PRATINJAU" ? (
        <div className="peringatan" role="status">
          <Icon name="eye" size={18} />
          <div>
            <p className="peringatan-judul">Ini pratinjau, belum tersimpan</p>
            <p className="peringatan-teks">
              Angka di bawah dihitung barusan dan tidak ditulis ke mana pun: tidak ada snapshot,
              tidak ada riwayat run, dan tidak ada mitra yang ditandai bermasalah. Laporan masih
              membaca hasil tersimpan sampai Anda menekan Jalankan dan simpan.
            </p>
          </div>
        </div>
      ) : null}

      {asal === "BARU_DIJALANKAN" && jalankan.hasil ? (
        <div className="peringatan" role="status">
          <Icon name="checkCircle" size={18} />
          <div>
            <p className="peringatan-judul">Klasifikasi tersimpan untuk {label}</p>
            <p className="peringatan-teks">
              {jalankan.hasil.menggantikanRunSebelumnya
                ? "Run ini menggantikan hasil sebelumnya untuk lingkup yang sama: snapshot lama ditulis ulang, bukan digandakan."
                : "Ini run pertama yang tersimpan untuk lingkup ini."}{" "}
              {jalankan.hasil.mitraDitandaiBermasalah.length === 0
                ? "Tidak ada mitra yang ditandai bermasalah."
                : `${formatCount(jalankan.hasil.mitraDitandaiBermasalah.length)} mitra ditandai bermasalah karena kolektibilitas macet.`}
            </p>
          </div>
        </div>
      ) : null}

      {/*
       * ONE BENTO, TWO COLUMNS THAT FLOW INDEPENDENTLY. The distribution and
       * the migration matrix are short tables; the provenance panel is a list
       * that grows one card per policy row in use. Put one of each in the same
       * grid ROW and the shorter card is stretched to the taller one, leaving a
       * void inside its border. Stacking the tables on the left and the
       * provenance plus the run history on the right keeps both columns at
       * comparable height with no empty space inside any card.
       */}
      <Bento columns={3}>
        <BentoItem span="wide">
          <div className="closing-kolom">
            <PanelSumber
              title="Distribusi kolektibilitas"
              description={`Sebaran akad per kelas untuk ${label}, ${namaCabang.toLowerCase()}.`}
              sumber={sumberAngka}
            >
              <Muat
                hasil={snapshot}
                judul="snapshot kolektibilitas"
                sumber="GET /api/closing/periode/:id/kolektibilitas/snapshot"
              >
                {() => <TabelDistribusi ringkasan={ringkasan} />}
              </Muat>
            </PanelSumber>

            <PanelSumber
              title="Perpindahan kolektibilitas"
              description="Dari kelas periode lalu ke kelas periode ini. Baris tanpa kelas asal adalah akad yang baru pertama kali dinilai."
              sumber={sumberAngka}
            >
              <TabelMatriks matriks={matriks} />
            </PanelSumber>
          </div>
        </BentoItem>

        <BentoItem span="sm">
          <div className="closing-kolom">
            <PanelSumber
              title="Dasar perhitungan penyisihan"
              description="Rate dan dasar yang benar benar dipakai, dibaca dari barisnya sendiri, bukan dari konfigurasi saat ini."
              sumber={sumberAngka}
            >
              <DataList
                items={[
                  {
                    label: "Mode penyisihan",
                    value:
                      LABEL_MODE_PENYISIHAN[
                        hitung ? hitung.modePenyisihan : referensi.kapabilitas.modePenyisihan
                      ] ?? "Tidak diketahui",
                  },
                  {
                    label: "Dasar perhitungan",
                    value:
                      LABEL_DASAR_PENYISIHAN[
                        hitung
                          ? hitung.dasarPerhitungan
                          : referensi.kapabilitas.dasarPerhitunganPenyisihan
                      ] ?? "Tidak diketahui",
                  },
                  {
                    label: "Tanggal pengukuran tunggakan",
                    value: formatDate(hitung ? hitung.tanggalAkhirPeriode : periode.tanggalAkhir),
                  },
                  {
                    label: "Akad diproses",
                    value: formatCount(hitung ? hitung.totalAkadDiproses : baris.length),
                    numeric: true,
                  },
                  {
                    label: "Total penyisihan dibutuhkan",
                    value: hitung
                      ? teksUang(hitung.totalPenyisihanDibutuhkan)
                      : formatTotal(baris.map((row) => row.nilaiPenyisihan)),
                    numeric: true,
                  },
                ]}
              />
              <TabelAsalRate baris={asalRate} />
            </PanelSumber>

            <PanelSumber
              title="Riwayat run"
              description={`Setiap run klasifikasi yang pernah tercatat untuk ${label}.`}
              sumber="GET /api/closing/periode/:id/kolektibilitas/riwayat"
            >
              <Muat
                hasil={riwayat}
                judul="riwayat run kolektibilitas"
                sumber="GET /api/closing/periode/:id/kolektibilitas/riwayat"
              >
                {(isi) => <TabelRiwayat rows={isi.data} />}
              </Muat>
            </PanelSumber>
          </div>
        </BentoItem>
      </Bento>

      {bolehJalankan ? null : (
        <TanpaWewenang judul="Anda membaca hasil klasifikasi, tanpa menjalankannya">
          Menjalankan maupun mempratinjau klasifikasi memerlukan kewenangan
          admin.closing.kolektibilitas. Dengan admin.closing.view saja, seluruh bukti di halaman ini
          tetap terbaca dan tidak ada satu pun tombol yang mengubah data.
        </TanpaWewenang>
      )}

      {pratinjau.status === "gagal" || jalankan.status === "gagal" ? (
        <p className="form-error" role="alert">
          <Icon name="alert" size={16} />
          <span>{pratinjau.error ?? jalankan.error}</span>
        </p>
      ) : null}

      <ConfirmDialog
        open={konfirmasi}
        title={`Jalankan klasifikasi kolektibilitas ${label}`}
        description="Berbeda dengan pratinjau, tindakan ini menulis hasilnya."
        confirmLabel="Jalankan dan simpan"
        loading={jalankan.status === "mengirim"}
        error={jalankan.error}
        onCancel={() => setKonfirmasi(false)}
        onConfirm={async () => {
          pratinjau.reset();
          const hasil = await jalankan.jalankan(undefined);
          if (hasil) {
            setKonfirmasi(false);
            snapshot.reload();
            riwayat.reload();
          }
        }}
      >
        <DataList
          items={[
            { label: "Periode", value: label },
            { label: "Lingkup", value: namaCabang, wide: true },
            {
              label: "Yang ditulis",
              value:
                "Snapshot kolektibilitas per akad, satu baris riwayat run, dan penandaan mitra bermasalah bila kebijakan mengaktifkannya",
              wide: true,
            },
            {
              label: "Bila sudah pernah dijalankan",
              value:
                "Snapshot lingkup ini ditulis ulang dalam satu transaksi, bukan digandakan, jadi jumlah snapshot dan jumlah jurnal tidak bertambah",
              wide: true,
            },
          ]}
        />
      </ConfirmDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function TabelDistribusi({ ringkasan }: { ringkasan: readonly RingkasanKelas[] }) {
  if (ringkasan.length === 0) {
    return (
      <HasilKosong
        judul="Belum ada hasil klasifikasi"
        teks="Belum ada satu baris snapshot pun untuk periode dan lingkup ini. Jalankan closing kolektibilitas lebih dulu, atau pilih periode lain."
      />
    );
  }

  const urut = [...ringkasan].sort(
    (a, b) => URUTAN_KELAS.indexOf(a.kelas) - URUTAN_KELAS.indexOf(b.kelas),
  );

  const columns: readonly Column<RingkasanKelas>[] = [
    {
      key: "kelas",
      header: "Kolektibilitas",
      width: "180px",
      render: (row) => <StatusBadge status={row.kelas} />,
    },
    {
      key: "jumlahAkad",
      header: "Jumlah akad",
      type: "count",
      width: "130px",
      render: (row) => <span className="angka">{formatCount(row.jumlahAkad)}</span>,
      footer: <span className="angka">{formatCount(urut.reduce((a, r) => a + r.jumlahAkad, 0))}</span>,
    },
    {
      key: "outstandingPokok",
      header: "Outstanding pokok",
      type: "money",
      render: (row) => <NilaiUang nilai={row.outstandingPokok} />,
      footer: <span className="angka">{formatTotal(urut.map((r) => r.outstandingPokok))}</span>,
    },
    {
      key: "nilaiPenyisihan",
      header: "Nilai penyisihan",
      type: "money",
      render: (row) => <NilaiUang nilai={row.nilaiPenyisihan} />,
      footer: <span className="angka">{formatTotal(urut.map((r) => r.nilaiPenyisihan))}</span>,
    },
  ];

  return (
    <>
      <div className="daftar-tabel">
        <DataTable
          columns={columns}
          rows={urut}
          rowKey={(row) => row.kelas}
          emptyTitle="Belum ada hasil klasifikasi"
        />
      </div>
      <div className="daftar-kartu">
        <ul className="kartu-list">
          {urut.map((row) => (
            <li className="kartu-item is-statis" key={row.kelas}>
              <div className="closing-kartu">
                <p className="kartu-judul">{LABEL_KELAS[row.kelas] ?? row.kelas}</p>
                <p className="kartu-sub">{formatCount(row.jumlahAkad)} akad</p>
                <dl className="closing-angka">
                  <div className="closing-sel">
                    <dt>Outstanding pokok</dt>
                    <dd className="angka">{teksUang(row.outstandingPokok)}</dd>
                  </div>
                  <div className="closing-sel">
                    <dt>Nilai penyisihan</dt>
                    <dd className="angka">{teksUang(row.nilaiPenyisihan)}</dd>
                  </div>
                </dl>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function TabelAsalRate({ baris }: { baris: readonly AsalRate[] }) {
  if (baris.length === 0) {
    return (
      <HasilKosong
        judul="Belum ada baris rate"
        teks="Rate dan dasar perhitungan tercatat pada setiap baris hasil klasifikasi. Selama belum ada hasil, belum ada rate yang bisa ditelusuri."
      />
    );
  }
  return (
    <ul className="rate-list">
      {baris.map((row) => (
        <li
          className="rate-item"
          key={`${row.kelas}#${row.rate}#${row.dasarPerhitungan}#${row.sumberRate}`}
        >
          <div className="rate-head">
            <StatusBadge status={row.kelas} />
            <span className="rate-nilai">{teksRate(row.rate)}</span>
          </div>
          <p className="rate-teks">
            {LABEL_DASAR_PENYISIHAN[row.dasarPerhitungan] ?? row.dasarPerhitungan}, bersumber dari{" "}
            {LABEL_SUMBER_RATE[row.sumberRate] ?? row.sumberRate}
          </p>
          <p className="rate-meta">{formatCount(row.jumlahAkad)} akad memakai baris ini</p>
        </li>
      ))}
    </ul>
  );
}

function TabelMatriks({ matriks }: { matriks: readonly SelKematriks[] }) {
  if (matriks.length === 0) {
    return (
      <HasilKosong
        judul="Belum ada perpindahan yang bisa ditampilkan"
        teks="Ringkasan perpindahan dihitung dari perbandingan kelas periode lalu dengan kelas periode ini, jadi ia baru terisi setelah klasifikasi periode ini ada."
      />
    );
  }

  const columns: readonly Column<SelKematriks>[] = [
    {
      key: "dari",
      header: "Kelas periode lalu",
      width: "190px",
      render: (row) =>
        row.dari === null ? (
          <span className="angka-kosong">Baru pertama dinilai</span>
        ) : (
          <StatusBadge status={row.dari} />
        ),
    },
    {
      key: "ke",
      header: "Kelas periode ini",
      width: "190px",
      render: (row) => <StatusBadge status={row.ke} />,
    },
    {
      key: "jumlahAkad",
      header: "Jumlah akad",
      type: "count",
      width: "130px",
      render: (row) => <span className="angka">{formatCount(row.jumlahAkad)}</span>,
    },
    {
      key: "outstandingPokok",
      header: "Outstanding pokok",
      type: "money",
      render: (row) => <NilaiUang nilai={row.outstandingPokok} />,
    },
  ];

  return (
    <>
      <div className="daftar-tabel">
        <DataTable
          columns={columns}
          rows={matriks}
          rowKey={(row) => `${row.dari ?? "BARU"}>${row.ke}`}
          emptyTitle="Belum ada perpindahan"
        />
      </div>
      <div className="daftar-kartu">
        <ul className="kartu-list">
          {matriks.map((row) => (
            <li className="kartu-item is-statis" key={`${row.dari ?? "BARU"}>${row.ke}`}>
              <div className="closing-kartu">
                <p className="kartu-judul">
                  {(row.dari === null ? "Baru dinilai" : (LABEL_KELAS[row.dari] ?? row.dari)) +
                    " ke " +
                    (LABEL_KELAS[row.ke] ?? row.ke)}
                </p>
                <p className="kartu-sub">{formatCount(row.jumlahAkad)} akad</p>
                <dl className="closing-angka">
                  <div className="closing-sel">
                    <dt>Outstanding pokok</dt>
                    <dd className="angka">{teksUang(row.outstandingPokok)}</dd>
                  </div>
                </dl>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function TabelRiwayat({ rows }: { rows: readonly RiwayatRunKolektibilitas[] }) {
  if (rows.length === 0) {
    return (
      <HasilKosong
        judul="Belum ada run tercatat"
        teks="Belum ada satu run klasifikasi pun untuk periode ini. Pratinjau tidak dicatat di sini, karena pratinjau memang tidak menulis apa pun."
      />
    );
  }
  return (
    <ul className="riwayat-list">
      {rows.map((row) => (
        <li className="riwayat-item" key={row.id}>
          <div className="riwayat-head">
            <span className="riwayat-tanggal">{formatDate(row.tanggalJalan)}</span>
            <StatusBadge status={row.status} label={LABEL_STATUS_RUN[row.status] ?? row.status} />
          </div>
          <p className="riwayat-teks">
            {formatCount(row.totalAkadDiproses)} akad diproses, dijalankan oleh{" "}
            {row.dijalankanOleh ?? "pengguna yang tidak tercatat"}
          </p>
          <p className="riwayat-meta">
            {row.cabangId === null ? "Seluruh cabang sekaligus" : "Satu cabang"}
          </p>
        </li>
      ))}
    </ul>
  );
}

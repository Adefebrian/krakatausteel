// Closing Periode, spec 8.2, 8.3 and 8.4. The screen an Approver reads before
// deciding to close a month, and the screen the close is executed from.
//
// THE CHECKLIST IS ALWAYS ALL TEN, AND IT IS READ FIRST. The engine never short
// circuits and this page never filters: an operator needs to know how much work
// is left, not which item happened to fail first. A failed check is not a red
// mark, it is a sentence in Indonesian, the figure behind it, and the list of
// journals or akad that caused it, because spec 16 scenario 12 requires the
// refusal to arrive "dengan alasan yang jelas" and a blocked close with nowhere
// to look is the failure that rule exists to prevent.
//
// READING THE CHECKLIST IS NOT EXECUTING THE CLOSE. `admin.closing.view` opens
// this whole page, which is what lets an Auditor read how a month was closed
// and what it was checked against; `admin.closing.periode` is what the
// allowance, the accrual and the close itself need. The Approver holds both and
// does the first before deciding whether to do the second.
//
// TWO CONFIRMATIONS, AND THEY ARE NOT THE SAME ONE. Check 8, negative cash, is
// a PERINGATAN: spec 8.4 calls it "warning, bukan blocker, tapi wajib
// dikonfirmasi user", so it is acknowledged HERE, beside the sentence that
// explains it, and the acknowledgement travels to the server as
// `konfirmasiKasNegatif` and lands in the audit log. The close itself is
// confirmed separately, in a dialog that states what will happen and requires a
// typed phrase. Neither of them overrides a GAGAL check; there is no control on
// this page that does, and there must never be one.
//
// A SKIPPED ACCRUAL IS AN OUTCOME, NOT A SILENCE. Under CASH_BASIS spec 8.3
// writes nothing and posts nothing, and the answer says so along with the
// method that produced it, so "policy says do nothing" is never drawn the same
// way as "something went wrong and produced nothing".
//
// THE PROVISION IS A SET OF JOURNALS, NOT ONE. Correction is by delta rather
// than by reversal, so a re-run at a corrected rate leaves the movement spread
// across several entries (migrations/0026). The panel lists every one of them
// and totals them, because summing that set reconciles with the period expense
// and following a single link does not.
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
  jalankanAkrual,
  jalankanPenyisihan,
  pratinjauPenyisihan,
  prasyaratClosing,
  tutupPeriode,
  type BarisAkrual,
  type DaftarPrasyarat,
  type HasilAkrual,
  type OpsiPeriodeClosing,
  type PenyisihanPeriode,
  type ReferensiClosing,
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
  HasilKosong,
  ItemPrasyarat,
  LABEL_KELAS,
  LABEL_METODE_JASA,
  NilaiUang,
  PanelSumber,
  TanpaWewenang,
  TautanJurnal,
  teksUang,
  useKonteksClosing,
} from "./parts";

const FRASA_TUTUP = "TUTUP PERIODE";

export function ClosingPeriode({ route }: { route: PageRoute }) {
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
                  description="Belum ada satu periode pun pada entitas ini, jadi belum ada bulan yang bisa ditutup. Periode dibentuk lebih dulu pada konfigurasi tahun buku."
                />
              ) : (
                <Isi
                  key={`${konteks.periode.id}#${konteks.cabangId ?? "SEMUA"}`}
                  periode={konteks.periode}
                  cabangId={konteks.cabangId}
                  namaCabang={konteks.namaCabang}
                  referensi={ref}
                  onPeriodeBerubah={() => konteks.daftar.reload()}
                />
              )
            }
          </Muat>
        )}
      </Muat>

      <p className="page-note">
        <Icon name="info" size={16} />
        <span>
          Closing membekukan saldo akun periode ini dari ledger, dan sejak itu setiap laporan bulan
          ini dibaca dari saldo beku tersebut, bukan dihitung ulang.
        </span>
      </p>
      <CatatanOtorisasi tambahan="Membaca checklist dan mengeksekusi closing adalah dua kewenangan terpisah." />
    </HalamanModul>
  );
}

// ---------------------------------------------------------------------------
// One month
// ---------------------------------------------------------------------------

function Isi({
  periode,
  cabangId,
  namaCabang,
  referensi,
  onPeriodeBerubah,
}: {
  periode: OpsiPeriodeClosing;
  cabangId: string | null;
  namaCabang: string;
  referensi: ReferensiClosing;
  onPeriodeBerubah: () => void;
}) {
  const session = useActiveSession();
  const bolehTutup = session.permissions.includes("admin.closing.periode");
  const label = formatPeriode(periode.tahun, periode.bulan);

  const prasyarat = useApi(() => prasyaratClosing(periode.id), [periode.id]);

  return (
    <>
      {periode.status === "CLOSED" ? (
        <div className="peringatan" role="status">
          <Icon name="checkCircle" size={18} />
          <div>
            <p className="peringatan-judul">Periode {label} sudah ditutup</p>
            <p className="peringatan-teks">
              Ditutup oleh {periode.closedOleh ?? "pengguna yang tidak tercatat"} pada{" "}
              {formatDate(periode.closedAt)}, dengan {formatCount(periode.jumlahSaldoBeku)} baris
              saldo beku. Checklist di bawah tetap bisa dibaca sebagai bukti keadaan periode ini.
            </p>
          </div>
        </div>
      ) : null}

      <Bento columns={3}>
        <BentoItem span="wide">
          <PanelSumber
            title={`Prasyarat closing ${label}`}
            description="Sepuluh pemeriksaan spesifikasi 8.4, seluruhnya, dalam urutan aslinya. Yang gagal menahan closing, yang berstatus perlu konfirmasi tidak menahan tetapi wajib diakui lebih dulu."
            sumber="GET /api/closing/periode/:id/prasyarat"
          >
            <Muat
              hasil={prasyarat}
              judul="prasyarat closing"
              sumber="GET /api/closing/periode/:id/prasyarat"
            >
              {(isi: DaftarPrasyarat) => (
                <ol className="prasyarat-list">
                  {isi.hasil.map((hasil) => (
                    <ItemPrasyarat hasil={hasil} key={hasil.kode} />
                  ))}
                </ol>
              )}
            </Muat>
          </PanelSumber>
        </BentoItem>

        <BentoItem span="sm">
          <PanelSumber
            title="Eksekusi closing"
            description="Kesiapan periode ini, dan tombol yang menutupnya."
            sumber="POST /api/closing/periode/:id/tutup"
          >
            <Muat
              hasil={prasyarat}
              judul="prasyarat closing"
              sumber="GET /api/closing/periode/:id/prasyarat"
            >
              {(isi: DaftarPrasyarat) => (
                <PanelTutup
                  periode={periode}
                  prasyarat={isi}
                  bolehTutup={bolehTutup}
                  onSelesai={() => {
                    prasyarat.reload();
                    onPeriodeBerubah();
                  }}
                />
              )}
            </Muat>
          </PanelSumber>
        </BentoItem>
      </Bento>

      <Bento columns={3}>
        <BentoItem span="wide">
          <PanelPenyisihan
            periode={periode}
            cabangId={cabangId}
            namaCabang={namaCabang}
            referensi={referensi}
            bolehJalankan={bolehTutup}
            onSelesai={() => prasyarat.reload()}
          />
        </BentoItem>

        <BentoItem span="sm">
          <PanelAkrual
            periode={periode}
            cabangId={cabangId}
            referensi={referensi}
            bolehJalankan={bolehTutup}
            onSelesai={() => prasyarat.reload()}
          />
        </BentoItem>
      </Bento>

      {bolehTutup ? null : (
        <TanpaWewenang judul="Anda membaca checklist, tanpa mengeksekusi closing">
          Menjalankan penyisihan, akrual, dan penutupan periode memerlukan kewenangan
          admin.closing.periode. Dengan admin.closing.view saja, seluruh bukti di halaman ini tetap
          terbaca dan tidak ada satu pun tombol yang mengubah data.
        </TanpaWewenang>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The close
// ---------------------------------------------------------------------------

function PanelTutup({
  periode,
  prasyarat,
  bolehTutup,
  onSelesai,
}: {
  periode: OpsiPeriodeClosing;
  prasyarat: DaftarPrasyarat;
  bolehTutup: boolean;
  onSelesai: () => void;
}) {
  const [diakui, setDiakui] = useState(false);
  const [konfirmasi, setKonfirmasi] = useState(false);
  const aksi = useAction((input: { konfirmasiKasNegatif: boolean }) =>
    tutupPeriode(periode.id, input),
  );

  const label = formatPeriode(periode.tahun, periode.bulan);
  const gagal = prasyarat.hasil.filter((h) => h.status === "GAGAL");
  const peringatan = prasyarat.hasil.filter((h) => h.status === "PERINGATAN");
  const lolos = prasyarat.hasil.filter((h) => h.status === "PASS");

  const ringkasan = (
    <DataList
      items={[
        {
          label: "Pemeriksaan lolos",
          value: `${formatCount(lolos.length)} dari ${formatCount(prasyarat.hasil.length)}`,
          numeric: true,
        },
        { label: "Pemeriksaan gagal", value: formatCount(gagal.length), numeric: true },
        {
          label: "Perlu konfirmasi",
          value: formatCount(peringatan.length),
          numeric: true,
        },
        {
          label: "Kesimpulan",
          value: prasyarat.boleh
            ? "Tidak ada pemeriksaan yang gagal, closing boleh dijalankan"
            : "Masih ada pemeriksaan yang gagal, closing akan ditolak server",
          wide: true,
        },
      ]}
    />
  );

  if (!bolehTutup) {
    return (
      <>
        {ringkasan}
        <TanpaWewenang judul="Eksekusi closing bukan kewenangan Anda">
          Menutup periode memerlukan kewenangan admin.closing.periode. Ringkasan di atas dan
          checklist di sebelahnya tetap terbaca, karena bagaimana sebuah bulan ditutup adalah bukti
          yang memang harus bisa dibaca tanpa hak menulis apa pun.
        </TanpaWewenang>
      </>
    );
  }

  if (periode.status === "CLOSED") {
    return (
      <>
        {ringkasan}
        <TanpaWewenang judul={`Periode ${label} sudah tertutup`}>
          Tidak ada closing yang perlu dijalankan lagi. Bila bulan ini memang harus dibuka kembali,
          tindakan itu dilakukan Admin Pusat di halaman Periode Akuntansi, dengan alasan tertulis.
        </TanpaWewenang>
      </>
    );
  }

  const siap = prasyarat.boleh && (!prasyarat.perluKonfirmasi || diakui);

  return (
    <>
      {ringkasan}

      {prasyarat.perluKonfirmasi ? (
        <div className="konfirmasi-kas">
          <p className="konfirmasi-kas-judul">Kondisi yang wajib Anda konfirmasi</p>
          {peringatan.map((h) => (
            <p className="konfirmasi-kas-teks" key={h.kode}>
              {h.alasan}
            </p>
          ))}
          <label className="filter-laporan-check">
            <input
              type="checkbox"
              checked={diakui}
              onChange={(event) => setDiakui(event.currentTarget.checked)}
            />
            <span>
              Saya mengonfirmasi kondisi di atas dan tetap melanjutkan closing. Konfirmasi ini
              tercatat pada audit log atas nama saya.
            </span>
          </label>
        </div>
      ) : null}

      <div className="closing-aksi">
        {aksi.status === "gagal" ? (
          <p className="form-error" role="alert">
            <Icon name="alert" size={16} />
            <span>{aksi.error}</span>
          </p>
        ) : null}
        <div className="closing-aksi-row">
          <Button
            variant="danger"
            disabled={!siap}
            leading={<Icon name="lock" size={16} />}
            onClick={() => setKonfirmasi(true)}
          >
            Tutup periode {label}
          </Button>
        </div>
        {prasyarat.boleh ? null : (
          <p className="closing-aksi-note">
            Tombol tertutup selama masih ada pemeriksaan yang gagal. Menyembunyikan tombol bukan
            pengaman: server memeriksa ulang seluruh checklist di dalam transaksi closing dan
            menolak bila ada yang gagal.
          </p>
        )}
      </div>

      <ConfirmDialog
        open={konfirmasi}
        tone="danger"
        title={`Tutup periode ${label}`}
        description="Baca dulu apa yang akan terjadi. Setelah ditutup, angka bulan ini dibaca dari saldo beku."
        confirmLabel="Ya, tutup periode"
        confirmPhrase={FRASA_TUTUP}
        confirmPhraseLabel="Ketik untuk mengonfirmasi penutupan"
        loading={aksi.status === "mengirim"}
        error={aksi.error}
        onCancel={() => setKonfirmasi(false)}
        onConfirm={async () => {
          const hasil = await aksi.jalankan({ konfirmasiKasNegatif: diakui });
          if (hasil) {
            setKonfirmasi(false);
            setDiakui(false);
            onSelesai();
          }
        }}
      >
        <DataList
          items={[
            { label: "Periode", value: label },
            { label: "Status setelah tindakan", value: "Tertutup" },
            {
              label: "Yang dibekukan",
              value:
                "Saldo awal, mutasi debit, mutasi kredit, dan saldo akhir setiap akun per cabang, dibaca dari ledger",
              wide: true,
            },
            {
              label: "Yang dicap",
              value: "Template laporan yang berlaku pada tanggal akhir periode ini",
              wide: true,
            },
            {
              label: "Konfirmasi saldo kas negatif",
              value: prasyarat.perluKonfirmasi
                ? diakui
                  ? "Dikirim sebagai konfirmasi eksplisit dan tercatat pada audit log"
                  : "Belum dikonfirmasi, server akan menolak"
                : "Tidak diperlukan pada periode ini",
              wide: true,
            },
            {
              label: "Setelah closing",
              value:
                "Jurnal bertanggal di bulan ini tidak bisa lagi diposting, dan laporan bulan ini dibaca dari saldo beku",
              wide: true,
            },
          ]}
        />
        <p className="konfirmasi-catatan">
          Di dalam transaksi penutupan, server memeriksa ulang seluruh checklist ini, karena
          pemeriksaan yang lolos semenit lalu bukan bukti. Tidak ada percobaan ulang otomatis:
          penutupan mengunci baris periode sampai transaksi selesai, sehingga dua penutupan
          bersamaan tetap menghasilkan tepat satu keberhasilan.
        </p>
      </ConfirmDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// 8.2 penyisihan
// ---------------------------------------------------------------------------

function PanelPenyisihan({
  periode,
  cabangId,
  namaCabang,
  referensi,
  bolehJalankan,
  onSelesai,
}: {
  periode: OpsiPeriodeClosing;
  cabangId: string | null;
  namaCabang: string;
  referensi: ReferensiClosing;
  bolehJalankan: boolean;
  onSelesai: () => void;
}) {
  const pratinjau = useAction<void, { data: PenyisihanPeriode[] }>(() =>
    pratinjauPenyisihan(periode.id, { cabangId }),
  );
  const jalankan = useAction<void, { data: PenyisihanPeriode[] }>(() =>
    jalankanPenyisihan(periode.id, { cabangId }),
  );
  const [konfirmasi, setKonfirmasi] = useState(false);

  const tersimpan = jalankan.hasil !== null;
  const hasil = jalankan.hasil?.data ?? pratinjau.hasil?.data ?? null;
  const label = formatPeriode(periode.tahun, periode.bulan);

  const namaCabangBaris = (id: string): string => {
    const cabang = referensi.cabang.find((c) => c.id === id);
    return cabang ? `${cabang.kode} ${cabang.nama}` : id;
  };

  const columns: readonly Column<PenyisihanPeriode>[] = [
    {
      key: "cabangId",
      header: "Cabang",
      render: (row) => <span className="sel-ringkas">{namaCabangBaris(row.cabangId)}</span>,
    },
    {
      key: "saldoPenyisihanAwal",
      header: "Saldo awal penyisihan",
      type: "money",
      width: "170px",
      render: (row) => <NilaiUang nilai={row.saldoPenyisihanAwal} />,
    },
    {
      key: "penyisihanDibutuhkan",
      header: "Dibutuhkan",
      type: "money",
      width: "150px",
      render: (row) => <NilaiUang nilai={row.penyisihanDibutuhkan} />,
    },
    {
      key: "bebanPenyisihanPeriode",
      header: "Beban periode",
      type: "money",
      width: "150px",
      render: (row) => <NilaiUang nilai={row.bebanPenyisihanPeriode} />,
    },
    {
      key: "eventCode",
      header: "Peristiwa",
      width: "170px",
      render: (row) =>
        row.eventCode === null ? (
          <span className="angka-kosong">Tidak ada jurnal</span>
        ) : (
          <StatusBadge
            status={row.eventCode}
            tone={row.eventCode === "BEBAN_PENYISIHAN" ? "info" : "success"}
            label={row.eventCode === "BEBAN_PENYISIHAN" ? "Beban penyisihan" : "Pemulihan penyisihan"}
          />
        ),
    },
    {
      key: "jurnal",
      header: "Jurnal pembentuk",
      render: (row) =>
        row.jurnal.length === 0 ? (
          <span className="angka-kosong">Belum ada jurnal</span>
        ) : (
          <ul className="jurnal-tautan">
            {row.jurnal.map((kontribusi) => (
              <li key={kontribusi.jurnalId}>
                <TautanJurnal jurnalId={kontribusi.jurnalId} />
                <span className="angka">{teksUang(kontribusi.nilai)}</span>
              </li>
            ))}
          </ul>
        ),
    },
  ];

  return (
    <PanelSumber
      title="Penyisihan kerugian piutang"
      description={`Pergerakan penyisihan ${label} untuk ${namaCabang.toLowerCase()}. Saldo awal dibaca dari ledger, bukan dijumlahkan dari snapshot periode lalu, supaya hapus buku tetap terlihat.`}
      sumber={
        tersimpan
          ? "POST /api/closing/periode/:id/penyisihan"
          : "POST /api/closing/periode/:id/penyisihan/pratinjau"
      }
    >
      {hasil === null ? (
        <HasilKosong
          judul="Belum dihitung pada layar ini"
          teks="Perhitungan penyisihan tidak dijalankan otomatis saat halaman dibuka, karena menjalankannya membentuk jurnal. Tekan Hitung tanpa memposting untuk melihat pergerakannya lebih dulu."
        />
      ) : hasil.length === 0 ? (
        <HasilKosong
          judul="Tidak ada cabang dengan hasil klasifikasi"
          teks="Penyisihan dihitung dari snapshot kolektibilitas, dan periode ini belum punya satu snapshot pun untuk lingkup yang dipilih. Jalankan closing kolektibilitas lebih dulu."
        />
      ) : (
        <>
          {tersimpan ? null : (
            <p className="closing-aksi-note">
              Ini hasil hitung tanpa posting: belum ada baris penyisihan periode yang ditulis dan
              belum ada jurnal yang terbentuk.
            </p>
          )}
          <div className="daftar-tabel">
            <DataTable
              columns={columns}
              rows={hasil}
              rowKey={(row) => row.cabangId}
              emptyTitle="Tidak ada baris penyisihan"
            />
          </div>
          <div className="daftar-kartu">
            <ul className="kartu-list">
              {hasil.map((row) => (
                <li className="kartu-item is-statis" key={row.cabangId}>
                  <div className="closing-kartu">
                    <p className="kartu-judul">{namaCabangBaris(row.cabangId)}</p>
                    <p className="kartu-sub">
                      {row.eventCode === null
                        ? "Pergerakan nol, tidak ada jurnal"
                        : row.eventCode === "BEBAN_PENYISIHAN"
                          ? "Beban penyisihan"
                          : "Pemulihan penyisihan"}
                    </p>
                    <dl className="closing-angka">
                      <div className="closing-sel">
                        <dt>Saldo awal</dt>
                        <dd className="angka">{teksUang(row.saldoPenyisihanAwal)}</dd>
                      </div>
                      <div className="closing-sel">
                        <dt>Dibutuhkan</dt>
                        <dd className="angka">{teksUang(row.penyisihanDibutuhkan)}</dd>
                      </div>
                      <div className="closing-sel">
                        <dt>Beban periode</dt>
                        <dd className="angka">{teksUang(row.bebanPenyisihanPeriode)}</dd>
                      </div>
                      <div className="closing-sel">
                        <dt>Jumlah jurnal</dt>
                        <dd className="angka">{formatCount(row.jurnal.length)}</dd>
                      </div>
                    </dl>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <p className="closing-aksi-note">
            Total beban periode seluruh cabang:{" "}
            <span className="angka">
              {formatTotal(hasil.map((row) => row.bebanPenyisihanPeriode))}
            </span>
            . Satu pergerakan bisa terbawa beberapa jurnal karena koreksi dilakukan lewat selisih,
            bukan lewat pembalikan, jadi yang berjumlah adalah himpunan jurnalnya.
          </p>
        </>
      )}

      {bolehJalankan ? (
        <div className="closing-aksi">
          {pratinjau.status === "gagal" || jalankan.status === "gagal" ? (
            <p className="form-error" role="alert">
              <Icon name="alert" size={16} />
              <span>{pratinjau.error ?? jalankan.error}</span>
            </p>
          ) : null}
          <div className="closing-aksi-row">
            <Button
              variant="secondary"
              loading={pratinjau.status === "mengirim"}
              disabled={periode.status !== "OPEN"}
              leading={<Icon name="calculator" size={16} />}
              onClick={async () => {
                jalankan.reset();
                await pratinjau.jalankan(undefined);
              }}
            >
              Hitung tanpa memposting
            </Button>
            <Button
              variant="primary"
              disabled={periode.status !== "OPEN"}
              leading={<Icon name="receipt" size={16} />}
              onClick={() => setKonfirmasi(true)}
            >
              Jalankan dan posting
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={konfirmasi}
        title={`Posting penyisihan ${label}`}
        description="Tindakan ini membentuk jurnal penyisihan, satu per cabang."
        confirmLabel="Jalankan dan posting"
        loading={jalankan.status === "mengirim"}
        error={jalankan.error}
        onCancel={() => setKonfirmasi(false)}
        onConfirm={async () => {
          pratinjau.reset();
          const keluar = await jalankan.jalankan(undefined);
          if (keluar) {
            setKonfirmasi(false);
            onSelesai();
          }
        }}
      >
        <DataList
          items={[
            { label: "Periode", value: label },
            { label: "Lingkup", value: namaCabang, wide: true },
            {
              label: "Yang dibentuk",
              value:
                "Satu baris penyisihan periode per cabang, dan satu jurnal per cabang yang pergerakannya tidak nol",
              wide: true,
            },
            {
              label: "Pergerakan nol",
              value:
                "Tidak memposting jurnal apa pun, dan itu bukan kegagalan: barisnya adalah pernyataan eksplisit bahwa pergerakannya nol",
              wide: true,
            },
          ]}
        />
      </ConfirmDialog>
    </PanelSumber>
  );
}

// ---------------------------------------------------------------------------
// 8.3 akrual
// ---------------------------------------------------------------------------

function PanelAkrual({
  periode,
  cabangId,
  referensi,
  bolehJalankan,
  onSelesai,
}: {
  periode: OpsiPeriodeClosing;
  cabangId: string | null;
  referensi: ReferensiClosing;
  bolehJalankan: boolean;
  onSelesai: () => void;
}) {
  const jalankan = useAction<void, HasilAkrual>(() => jalankanAkrual(periode.id, { cabangId }));
  const [konfirmasi, setKonfirmasi] = useState(false);
  const hasil = jalankan.hasil;
  const label = formatPeriode(periode.tahun, periode.bulan);
  const metode = hasil?.metode ?? referensi.kapabilitas.metodePengakuanJasa;
  const kelas = hasil?.kelasDiakrual ?? referensi.kapabilitas.kelasDiakrual;

  const namaCabangBaris = (id: string): string => {
    const cabang = referensi.cabang.find((c) => c.id === id);
    return cabang ? `${cabang.kode} ${cabang.nama}` : id;
  };

  return (
    <PanelSumber
      title="Akrual jasa administrasi"
      description="Jasa yang jatuh tempo di bulan ini tetapi belum diterima kasnya. Metodenya dibaca dari konfigurasi dan tidak bisa diubah dari halaman ini."
      sumber="POST /api/closing/periode/:id/akrual"
    >
      <DataList
        items={[
          {
            label: "Metode pengakuan",
            value: LABEL_METODE_JASA[metode] ?? metode,
          },
          {
            label: "Kelas yang diakru",
            value:
              kelas.length === 0
                ? "Tidak ada kelas yang diakru"
                : kelas.map((k) => LABEL_KELAS[k] ?? k).join(", "),
            wide: true,
          },
        ]}
      />

      {hasil === null ? (
        <HasilKosong
          judul="Belum dijalankan pada layar ini"
          teks={
            metode === "CASH_BASIS"
              ? "Metode yang berlaku adalah cash basis, jadi langkah ini memang tidak akan membentuk jurnal apa pun. Menjalankannya tetap mencatat bahwa langkah ini sudah ditempuh."
              : "Akrual tidak dijalankan otomatis saat halaman dibuka, karena menjalankannya membentuk jurnal per cabang."
          }
        />
      ) : hasil.dilewati ? (
        <div className="peringatan" role="status">
          <Icon name="info" size={18} />
          <div>
            <p className="peringatan-judul">Langkah akrual dilewati sesuai kebijakan</p>
            <p className="peringatan-teks">
              Metode pengakuan jasa administrasi yang berlaku adalah{" "}
              {LABEL_METODE_JASA[hasil.metode] ?? hasil.metode}, jadi tidak ada snapshot dan tidak
              ada jurnal yang dibentuk. Ini hasil kebijakan, bukan kegagalan, dan prasyarat closing
              nomor 6 tetap lolos karenanya.
            </p>
          </div>
        </div>
      ) : (
        <>
          <DataList
            items={[
              {
                label: "Akad diakru",
                value: formatCount(hasil.baris.length),
                numeric: true,
              },
              {
                label: "Total jasa diakru",
                value: formatTotal(hasil.baris.map((row: BarisAkrual) => row.jasaDiakrual)),
                numeric: true,
              },
            ]}
          />
          <ul className="jurnal-list">
            {hasil.totalPerCabang.map((row) => (
              <li className="jurnal-item" key={row.cabangId}>
                <div className="jurnal-head">
                  <span className="jurnal-nama">{namaCabangBaris(row.cabangId)}</span>
                  <span className="angka">{teksUang(row.total)}</span>
                </div>
                <TautanJurnal jurnalId={row.jurnalId} />
              </li>
            ))}
          </ul>
        </>
      )}

      {bolehJalankan ? (
        <div className="closing-aksi">
          {jalankan.status === "gagal" ? (
            <p className="form-error" role="alert">
              <Icon name="alert" size={16} />
              <span>{jalankan.error}</span>
            </p>
          ) : null}
          <div className="closing-aksi-row">
            <Button
              variant="primary"
              disabled={periode.status !== "OPEN"}
              leading={<Icon name="receipt" size={16} />}
              onClick={() => setKonfirmasi(true)}
            >
              Jalankan akrual
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={konfirmasi}
        title={`Jalankan akrual jasa administrasi ${label}`}
        description="Tindakan ini menulis snapshot akrual dan, bila metodenya akrual, memposting jurnal per cabang."
        confirmLabel="Jalankan akrual"
        loading={jalankan.status === "mengirim"}
        error={jalankan.error}
        onCancel={() => setKonfirmasi(false)}
        onConfirm={async () => {
          const keluar = await jalankan.jalankan(undefined);
          if (keluar) {
            setKonfirmasi(false);
            onSelesai();
          }
        }}
      >
        <DataList
          items={[
            { label: "Periode", value: label },
            { label: "Metode yang berlaku", value: LABEL_METODE_JASA[metode] ?? metode },
            {
              label: "Bila metodenya cash basis",
              value:
                "Tidak ada snapshot dan tidak ada jurnal yang dibentuk, dan jawabannya menyebut metode yang menghasilkan keadaan itu",
              wide: true,
            },
            {
              label: "Bila metodenya akrual",
              value: `Snapshot akrual per akad berkolektibilitas ${
                kelas.length === 0 ? "yang dikonfigurasi" : kelas.map((k) => LABEL_KELAS[k] ?? k).join(", ")
              }, dan satu jurnal per cabang`,
              wide: true,
            },
          ]}
        />
      </ConfirmDialog>
    </PanelSumber>
  );
}

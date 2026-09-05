// "Hapus Jurnal Transaksi", spec 9.4, and spec 16 scenario 10.
//
// THIS SCREEN IS CALLED DELETE AND IT DOES NOT DELETE, AND THAT HAS TO BE
// UNMISTAKABLE BEFORE THE CLICK RATHER THAN EXPLAINED AFTERWARDS.
//
// Spec 9.4 names the screen "Hapus Jurnal Transaksi" because that is what an
// operator looks for when a posted entry is wrong. ADR 0010 records what
// actually happens: two rows are ADDED and none is removed, the original stays
// in the ledger marked REVERSED, and `v_ledger_baris` counts both halves so the
// pair nets to zero. A screen that accepted the word "hapus" and quietly
// reversed would be worse than either honest option, because the operator would
// go on believing the document is gone and would look for it in a report that
// still contains it.
//
// SO THE PAGE MAKES THE CORRECTION VISIBLE IN FIVE PLACES, BEFORE ANYTHING IS
// SENT, and each of them is load bearing rather than reassurance:
//
//   1. THE HEADING AND EVERY CONTROL SAY "JURNAL PEMBALIK". Not one button on
//      this page carries the word "hapus". The navigation entry keeps the
//      spec's own label, because that is the word the operator searches for,
//      and the page corrects it at the moment they arrive.
//   2. A PANEL STATES THE THREE FACTS IN WORDS, first thing, above the picker:
//      the original stays, a NEW document is created, and it is dated in the
//      current open period rather than in the original's.
//   3. THE PREVIEW IS SIDE BY SIDE. The original's lines and the reversing
//      lines, debit against credit, with both totals. An accountant reads the
//      swap rather than being told about it.
//   4. THE REASON IS MANDATORY AND IS NOT A FORMALITY. Ten characters minimum,
//      counted live, and the sentence lands verbatim in the reversing journal's
//      `keterangan` and in the audit log, which the field says out loud.
//   5. THE CONFIRMATION REPEATS IT AND ASKS FOR THE DOCUMENT NUMBER. Typing the
//      number is what stops a destructive click being a muscle memory Enter,
//      and the dialog's own title is "Buat jurnal pembalik", never "Hapus".
//
// AND AFTER THE CLICK, THE RESULT IS THE NEW DOCUMENT: its number, its lines,
// and the sentence that the original is still in the ledger with status
// REVERSED, with a link to open it and see so.
//
// TWO REFUSALS THE PICKER PREVENTS AND THE PAGE STILL EXPLAINS. A DRAFT is
// refused with `JURNAL_BELUM_POSTED` because a draft is CANCELLED, not
// reversed; a document already reversed is refused with `JURNAL_SUDAH_REVERSED`
// and its existing pair is shown instead of a second reversal.
import { useState } from "react";
import {
  Button,
  ConfirmDialog,
  DataList,
  DataTable,
  Field,
  Icon,
  Panel,
  SearchInput,
  Textarea,
  formatCount,
  formatDate,
  formatMoney,
  jumlahkanUang,
  type Column,
} from "@krakatausteel/ui";
import {
  buatPembalik,
  daftarJurnal,
  detailJurnal,
  MAKS_ALASAN_PEMBALIK,
  MIN_ALASAN_PEMBALIK,
  type BarisJurnalTampil,
  type JurnalTampil,
} from "../../api/jurnal";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { Link } from "../../router";
import {
  AntreanKosong,
  CatatanOtorisasi,
  HalamanModul,
  Muat,
  useLingkupCabang,
  usePilihan,
} from "../shared/parts";
import {
  BadgeJurnal,
  CatatanBatas,
  DaftarJurnalTabel,
  labelJenis,
  RingkasJurnal,
} from "./parts";

export function Pembalik({ route }: { route: PageRoute }) {
  const lingkup = useLingkupCabang("Cabang");
  const [dokumenId, setDokumenId] = usePilihan("dokumen");
  const [cari, setCari] = useState("");
  const [alasan, setAlasan] = useState("");
  const [konfirmasi, setKonfirmasi] = useState(false);

  const daftar = useApi(
    () => daftarJurnal({ status: "POSTED", cabangId: lingkup.cabangId, cari: cari.trim() || null }),
    [lingkup.cabangId, cari],
  );
  const dokumen = useApi(() => detailJurnal(dokumenId ?? ""), [dokumenId], {
    enabled: dokumenId !== null,
  });
  const buat = useAction((input: { id: string; alasan: string }) =>
    buatPembalik(input.id, input.alasan),
  );

  const alasanBersih = alasan.trim();
  const alasanCukup =
    alasanBersih.length >= MIN_ALASAN_PEMBALIK && alasanBersih.length <= MAKS_ALASAN_PEMBALIK;

  async function jalankan() {
    if (!dokumenId || !alasanCukup) return;
    const hasil = await buat.jalankan({ id: dokumenId, alasan: alasanBersih });
    if (hasil) {
      setKonfirmasi(false);
      daftar.reload();
      dokumen.reload();
    }
  }

  // After a successful reversal the page shows the NEW document, because that
  // is what was created. Showing "berhasil dihapus" here would undo everything
  // the rest of this screen says.
  if (buat.hasil) {
    return (
      <HalamanModul route={route} title="Jurnal pembalik terbentuk">
        <HasilPembalik
          pembalikId={buat.hasil.id}
          noPembalik={buat.hasil.noJurnal}
          totalDebit={buat.hasil.totalDebit}
          totalKredit={buat.hasil.totalKredit}
          tanggal={buat.hasil.tanggalTransaksi}
          asli={dokumen.data}
          onLagi={() => {
            buat.reset();
            setAlasan("");
            setDokumenId(null);
          }}
        />
        <CatatanOtorisasi tambahan="Pembentukan jurnal pembalik memerlukan kewenangan jurnal.reversal." />
      </HalamanModul>
    );
  }

  return (
    <HalamanModul
      route={route}
      title="Koreksi jurnal POSTED dengan jurnal pembalik"
      sub="Menu ini bernama Hapus Jurnal Transaksi. Yang terjadi di sini bukan penghapusan, melainkan pembentukan jurnal pembalik."
    >
      <PenjelasanPembalik />

      <div className="filter-laporan">
        {lingkup.kontrol}
        <label className="filter-laporan-group is-lebar">
          <span className="filter-laporan-label">Cari nomor atau keterangan</span>
          <SearchInput
            label="Cari nomor jurnal atau keterangan"
            value={cari}
            onChange={(event) => setCari(event.currentTarget.value)}
          />
        </label>
        <p className="filter-laporan-catatan">
          Daftar ini hanya berisi dokumen berstatus POSTED. Dokumen DRAFT tidak dibalik, melainkan
          dibatalkan oleh pembuatnya, dan dokumen yang sudah pernah dibalik tidak muncul lagi di
          sini karena statusnya bukan POSTED lagi.
        </p>
      </div>

      <Muat hasil={daftar} judul="daftar jurnal POSTED" sumber="GET /api/jurnal?status=POSTED">
        {(data) => (
          <>
            <Panel
              as="h2"
              title="Pilih dokumen yang akan dibalik"
              description="Satu dokumen POSTED. Isinya ditampilkan lengkap sebelum ada satu pun yang dikirim ke server."
              footer={
                <span className="panel-foot-note">
                  Sumber: GET /api/jurnal?status=POSTED. Kewenangan jurnal.view untuk membaca,
                  jurnal.reversal untuk membentuk pembalik.
                </span>
              }
            >
              <DaftarJurnalTabel
                rows={data.data}
                onPilih={(row) => {
                  setDokumenId(row.id);
                  setAlasan("");
                }}
                emptyTitle="Tidak ada dokumen POSTED pada filter ini"
                emptyDescription="Longgarkan filter cabang atau ganti kata kunci pencarian."
                caption="Dokumen POSTED yang bisa dibalik"
              />
            </Panel>
            <CatatanBatas jumlah={data.data.length} />
          </>
        )}
      </Muat>

      {dokumenId === null ? (
        <Panel as="h2" title="Belum ada dokumen dipilih">
          <AntreanKosong
            icon="jurnal"
            title="Pilih satu dokumen POSTED di atas"
            description="Pratinjau jurnal pembalik, lengkap dengan debit dan kredit yang tertukar, muncul di sini setelah satu dokumen dipilih."
          />
        </Panel>
      ) : (
        <Muat hasil={dokumen} judul="isi dokumen" sumber={`GET /api/jurnal/${dokumenId}`}>
          {(asli) => (
            <>
              {asli.status === "REVERSED" ? (
                <SudahDibalik jurnal={asli} />
              ) : asli.status !== "POSTED" ? (
                <BelumPosted jurnal={asli} />
              ) : (
                <>
                  <Panel
                    as="h2"
                    title={`Dokumen asal ${asli.noJurnal}`}
                    description="Dokumen ini tetap ada di buku besar setelah pembalikan, dengan status berubah menjadi Dibalik."
                    aside={<BadgeJurnal status={asli.status} verifiedAt={asli.verifiedAt} />}
                  >
                    <RingkasJurnal jurnal={asli} />
                  </Panel>

                  <PratinjauPembalik asli={asli} />

                  <Panel
                    as="h2"
                    title="Alasan pembalikan"
                    description="Kalimat ini tersimpan pada keterangan jurnal pembalik dan pada audit log, dan itulah yang dibaca auditor berbulan bulan kemudian."
                  >
                    <Field
                      label="Alasan pembalikan"
                      htmlFor="alasan-pembalik"
                      required
                      error={
                        alasanBersih.length > 0 && !alasanCukup
                          ? `Alasan wajib ${MIN_ALASAN_PEMBALIK} sampai ${MAKS_ALASAN_PEMBALIK} karakter.`
                          : undefined
                      }
                      hint={`Terisi ${formatCount(alasanBersih.length)} dari minimal ${MIN_ALASAN_PEMBALIK} karakter. Tulis apa yang salah pada dokumen asal, bukan sekadar kata koreksi.`}
                    >
                      <Textarea
                        id="alasan-pembalik"
                        rows={3}
                        maxLength={MAKS_ALASAN_PEMBALIK}
                        value={alasan}
                        invalid={alasanBersih.length > 0 && !alasanCukup}
                        onChange={(event) => setAlasan(event.currentTarget.value)}
                      />
                    </Field>

                    <div className="form-actions-row">
                      <Button variant="ghost" onClick={() => setDokumenId(null)}>
                        Pilih dokumen lain
                      </Button>
                      <Button
                        variant="danger"
                        disabled={!alasanCukup}
                        leading={<Icon name="history" size={16} />}
                        onClick={() => setKonfirmasi(true)}
                      >
                        Buat jurnal pembalik
                      </Button>
                    </div>
                    {buat.error ? (
                      <p className="form-error" role="alert">
                        <Icon name="alert" size={16} />
                        <span>{buat.error}</span>
                      </p>
                    ) : null}
                  </Panel>

                  <ConfirmDialog
                    open={konfirmasi}
                    title={`Buat jurnal pembalik untuk ${asli.noJurnal}`}
                    description="Dokumen asal tidak dihapus. Sistem membentuk dokumen baru berjenis Jurnal Pembalik dengan debit dan kredit tertukar, dan dokumen asal berubah status menjadi Dibalik."
                    confirmLabel="Buat jurnal pembalik"
                    tone="danger"
                    confirmPhrase={asli.noJurnal}
                    confirmPhraseLabel="Ketik nomor dokumen asal untuk mengonfirmasi"
                    loading={buat.status === "mengirim"}
                    error={buat.error}
                    onCancel={() => setKonfirmasi(false)}
                    onConfirm={() => void jalankan()}
                  >
                    <DataList
                      items={[
                        { label: "Dokumen asal", value: asli.noJurnal },
                        { label: "Jenis dokumen asal", value: labelJenis(asli.jenis) },
                        {
                          label: "Nilai yang dibalik",
                          value: formatMoney(asli.totalDebit),
                          numeric: true,
                        },
                        {
                          label: "Yang terjadi pada dokumen asal",
                          value: "Tetap ada di buku besar, status menjadi Dibalik",
                          wide: true,
                        },
                        {
                          label: "Yang dibentuk sistem",
                          value:
                            "Satu dokumen baru berjenis Jurnal Pembalik, bertanggal di periode terbuka saat ini",
                          wide: true,
                        },
                        { label: "Alasan yang tersimpan", value: alasanBersih, wide: true },
                      ]}
                    />
                  </ConfirmDialog>
                </>
              )}
            </>
          )}
        </Muat>
      )}

      <CatatanOtorisasi tambahan="Pembentukan jurnal pembalik memerlukan kewenangan jurnal.reversal, yang sengaja bukan kewenangan yang sama dengan posting." />
    </HalamanModul>
  );
}

// ---------------------------------------------------------------------------
// The statement, above everything, before a document is even chosen
// ---------------------------------------------------------------------------

function PenjelasanPembalik() {
  return (
    <Panel
      as="h2"
      title="Yang terjadi di halaman ini bukan penghapusan"
      description="Baca tiga hal berikut sebelum memilih dokumen. Ketiganya berlaku pada setiap pembalikan, tanpa pengecualian."
      className="panel-pembalik panel-panduan"
    >
      <ol className="langkah-list">
        <li>
          <strong>Dokumen asal tetap ada di buku besar.</strong> Statusnya berubah menjadi Dibalik,
          seluruh barisnya tetap tercatat, dan laporan tetap membaca kedua dokumen sebagai satu
          pasangan yang saling menghapus. Tidak ada baris yang dibuang dari basis data.
        </li>
        <li>
          <strong>Sistem membentuk dokumen baru.</strong> Jenisnya Jurnal Pembalik, dengan akun yang
          sama, nilai yang sama sampai ke rupiah terakhir, dan posisi debit serta kredit yang
          tertukar. Nomor dokumennya dialokasikan server.
        </li>
        <li>
          <strong>Tanggalnya bukan tanggal dokumen asal.</strong> Jurnal pembalik bertanggal di
          periode akuntansi yang masih terbuka, karena periode dokumen asal bisa saja sudah
          ditutup. Nomor dokumen asal dikutip pada keterangannya.
        </li>
      </ol>
      <p className="peringatan-teks">
        Alasan pembalikan wajib diisi minimal {MIN_ALASAN_PEMBALIK} karakter dan tersimpan apa
        adanya pada keterangan jurnal pembalik serta pada audit log. Dokumen yang sudah pernah
        dibalik ditolak server, karena satu dokumen hanya punya satu pasangan pembalik.
      </p>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// The preview, side by side
// ---------------------------------------------------------------------------

interface BarisPratinjau {
  id: string;
  urutan: number;
  akun: string;
  debit: string;
  kredit: string;
}

const KOLOM_PRATINJAU: readonly Column<BarisPratinjau>[] = [
  { key: "urutan", header: "No", type: "count", width: "60px" },
  { key: "akun", header: "Akun" },
  { key: "debit", header: "Debit", type: "money", width: "150px" },
  { key: "kredit", header: "Kredit", type: "money", width: "150px" },
];

/**
 * The swap, shown rather than described.
 *
 * IT IS LABELLED A PREVIEW AND NOT A PROMISE about the document number or the
 * date, because the server allocates both: the number comes from the per (jenis,
 * periode) sequence and the date from whichever period is open when the request
 * lands. Everything this table DOES claim, the accounts, the amounts and the
 * sides, is exactly what the engine writes: same accounts, same amounts to the
 * sen, same sub ledger dimensions, sides exchanged.
 */
function PratinjauPembalik({ asli }: { asli: JurnalTampil }) {
  const kiri: BarisPratinjau[] = asli.baris.map(barisAsli);
  const kanan: BarisPratinjau[] = asli.baris.map(barisDibalik);
  return (
    <Panel
      as="h2"
      title="Pratinjau pasangan dokumen"
      description="Kiri adalah dokumen asal yang tetap ada. Kanan adalah dokumen baru yang akan dibentuk, dengan debit dan kredit tertukar."
      footer={
        <span className="panel-foot-note">
          Nomor dan tanggal jurnal pembalik ditetapkan server saat dokumen dibentuk, jadi keduanya
          belum bisa ditampilkan di pratinjau ini.
        </span>
      }
    >
      <div className="banding">
        <div className="banding-sisi">
          <h3 className="banding-judul">Dokumen asal {asli.noJurnal}, tetap ada</h3>
          <p className="banding-sub">
            {labelJenis(asli.jenis)} . {formatDate(asli.tanggalTransaksi)} . {asli.periodeLabel}
          </p>
          <TabelPratinjau rows={kiri} />
        </div>
        <div className="banding-sisi">
          <h3 className="banding-judul">Jurnal pembalik yang akan dibentuk</h3>
          <p className="banding-sub">
            Jurnal Pembalik . tanggal di periode terbuka saat ini . nomor dialokasikan server
          </p>
          <TabelPratinjau rows={kanan} />
        </div>
      </div>
      <p className="periksa-ok">
        <Icon name="check" size={16} />
        <span>
          Total kedua dokumen sama besar dan berlawanan arah, sehingga jumlahnya nol di buku besar:
          debit {formatMoney(asli.totalDebit)} berpasangan dengan kredit{" "}
          {formatMoney(jumlahkanUang(kanan.map((row) => row.kredit)) ?? "0.00")}.
        </span>
      </p>
    </Panel>
  );
}

/**
 * One preview column, as a table on a desk and as cards on a phone.
 *
 * BOTH SHAPES, DRIVEN BY THE SAME ROWS. `.daftar-tabel` is hidden on a phone by
 * the shared stylesheet, so a preview that shipped only the table would render
 * as an empty panel at 390, on the one screen whose whole purpose is to show
 * what is about to happen. Caught by looking at it, not by a test.
 */
function TabelPratinjau({ rows }: { rows: readonly BarisPratinjau[] }) {
  const kolom = KOLOM_PRATINJAU.map((k) =>
    k.key === "debit"
      ? { ...k, footer: formatMoney(jumlahkanUang(rows.map((r) => r.debit)) ?? "0.00") }
      : k.key === "kredit"
        ? { ...k, footer: formatMoney(jumlahkanUang(rows.map((r) => r.kredit)) ?? "0.00") }
        : k.key === "urutan"
          ? { ...k, footer: "Total" }
          : k,
  );
  return (
    <>
      <div className="daftar-tabel">
        <DataTable
          columns={kolom}
          rows={rows}
          rowKey={(row) => row.id}
          emptyTitle="Dokumen ini tidak punya baris"
        />
      </div>
      <div className="daftar-kartu">
        <ul className="baris-kartu-list">
          {rows.map((row) => (
            <li className="baris-kartu" key={row.id}>
              <span className="baris-kartu-head">
                <span className="baris-kartu-kode">Baris {formatCount(row.urutan)}</span>
                <span className="baris-kartu-sisi">
                  {row.debit === "0.00" ? "Kredit" : "Debit"}
                </span>
              </span>
              <span className="baris-kartu-nama">{row.akun}</span>
              <span className="baris-kartu-foot">
                <span className="baris-kartu-ket">
                  {row.debit === "0.00" ? "sisi kredit" : "sisi debit"}
                </span>
                <span className="baris-kartu-nilai">
                  {formatMoney(row.debit === "0.00" ? row.kredit : row.debit)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function barisAsli(baris: BarisJurnalTampil): BarisPratinjau {
  return {
    id: `asli-${baris.id}`,
    urutan: baris.urutan,
    akun: `${baris.akunKode} ${baris.akunNama}`,
    debit: baris.debit,
    kredit: baris.kredit,
  };
}

/** The swap, and only the swap: accounts and amounts are carried across whole. */
function barisDibalik(baris: BarisJurnalTampil): BarisPratinjau {
  return {
    id: `balik-${baris.id}`,
    urutan: baris.urutan,
    akun: `${baris.akunKode} ${baris.akunNama}`,
    debit: baris.kredit,
    kredit: baris.debit,
  };
}

// ---------------------------------------------------------------------------
// After the click, and the two documents that cannot be reversed
// ---------------------------------------------------------------------------

function HasilPembalik({
  pembalikId,
  noPembalik,
  totalDebit,
  totalKredit,
  tanggal,
  asli,
  onLagi,
}: {
  pembalikId: string;
  noPembalik: string;
  totalDebit: string;
  totalKredit: string;
  tanggal: string;
  asli: JurnalTampil | null;
  onLagi: () => void;
}) {
  return (
    <>
      <Panel
        as="h2"
        title={`Jurnal pembalik ${noPembalik} terbentuk`}
        description="Satu dokumen baru masuk ke buku besar. Tidak ada dokumen yang dihapus."
      >
        <DataList
          items={[
            { label: "Nomor jurnal pembalik", value: noPembalik },
            { label: "Tanggal jurnal pembalik", value: formatDate(tanggal) },
            { label: "Total debit", value: formatMoney(totalDebit), numeric: true },
            { label: "Total kredit", value: formatMoney(totalKredit), numeric: true },
            {
              label: "Dokumen asal",
              value:
                asli === null
                  ? "tetap ada di buku besar dengan status Dibalik"
                  : `${asli.noJurnal}, tetap ada di buku besar dengan status Dibalik`,
              wide: true,
            },
          ]}
        />
        <div className="form-actions-row">
          <Link
            className="tautan-dokumen"
            to={`/jurnal?dokumen=${encodeURIComponent(pembalikId)}`}
          >
            Buka jurnal pembalik
          </Link>
          {asli === null ? null : (
            <Link
              className="tautan-dokumen"
              to={`/jurnal?dokumen=${encodeURIComponent(asli.id)}`}
            >
              Buka dokumen asal, statusnya kini Dibalik
            </Link>
          )}
          <Button variant="primary" onClick={onLagi}>
            Kembali ke daftar dokumen
          </Button>
        </div>
      </Panel>
      <p className="page-note">
        <Icon name="info" size={16} />
        <span>
          Kedua dokumen kini terhitung di buku besar dan saling menghapus. Laporan periode berjalan
          membaca keduanya, jadi nilai bersihnya nol, dan riwayat koreksinya tetap terbaca oleh
          siapa pun yang memeriksanya nanti.
        </span>
      </p>
    </>
  );
}

function SudahDibalik({ jurnal }: { jurnal: JurnalTampil }) {
  return (
    <Panel
      as="h2"
      title={`Dokumen ${jurnal.noJurnal} sudah pernah dibalik`}
      description="Satu dokumen hanya punya satu pasangan pembalik. Server menolak pembalikan kedua atas dokumen yang sama."
      aside={<BadgeJurnal status={jurnal.status} verifiedAt={jurnal.verifiedAt} />}
    >
      <RingkasJurnal jurnal={jurnal} />
      {jurnal.dibalikOleh ? (
        <p className="periksa-ok">
          <Icon name="check" size={16} />
          <span>
            Pasangannya adalah{" "}
            <Link
              className="tautan-dokumen"
              to={`/jurnal?dokumen=${encodeURIComponent(jurnal.dibalikOleh.id)}`}
            >
              {jurnal.dibalikOleh.noJurnal}
            </Link>
            . Kedua dokumen tetap ada di buku besar.
          </span>
        </p>
      ) : null}
    </Panel>
  );
}

function BelumPosted({ jurnal }: { jurnal: JurnalTampil }) {
  return (
    <Panel
      as="h2"
      title={`Dokumen ${jurnal.noJurnal} belum diposting`}
      description="Dokumen DRAFT tidak dibalik. Yang bisa dilakukan atasnya adalah diperbaiki atau dibatalkan oleh pembuatnya, karena dokumen itu belum masuk buku besar sama sekali."
      aside={<BadgeJurnal status={jurnal.status} verifiedAt={jurnal.verifiedAt} />}
    >
      <RingkasJurnal jurnal={jurnal} />
    </Panel>
  );
}

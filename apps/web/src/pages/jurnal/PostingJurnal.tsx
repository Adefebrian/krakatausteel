// Posting Jurnal, spec 9.4. The Approver's act: a DRAFT enters the ledger and
// can never be changed again.
//
// THE BATCH IS ALL OR NOTHING, AND THE PAGE SAYS SO BEFORE THE CLICK. Spec
// 6.6.8: one invalid member leaves NOTHING posted and the refusal names the
// journal that stopped it. An operator who posts forty documents and reads
// "gagal" has to know whether thirty nine landed; the answer is none did, and
// that belongs in the confirmation, not in a support call afterwards.
//
// VERIFICATION IS NOT A PRECONDITION IN THE ENGINE, AND THE PAGE DOES NOT
// PRETEND IT IS. `postingJurnal` checks that the document is a DRAFT, that its
// period is still OPEN, that it has at least two lines and that it balances. It
// does NOT check `verified_at`. So an unverified draft is shown here with that
// fact on the row rather than filtered out: hiding it would leave an Approver
// unable to find a document the server would happily post, and pretending the
// server refuses it would be a rule this page invented. The operational
// expectation, that a Checker reads it first, is stated in words and the row
// carries the evidence either way.
//
// NOTHING HERE RETRIES. Two concurrent posts of one document produce exactly
// one POSTED journal and the loser refuses with `POSTING_BENTROK`; retrying on
// that refusal would hand the loser a second attempt against a document the
// winner has already posted.
import { useState } from "react";
import {
  Bento,
  BentoItem,
  Button,
  ConfirmDialog,
  DataList,
  Icon,
  Panel,
  formatCount,
  formatDate,
  formatMoney,
  formatTotal,
} from "@krakatausteel/ui";
import {
  daftarJurnal,
  detailJurnal,
  MAKS_BATCH_POSTING,
  postingBatch,
  postingJurnal,
  type RingkasanJurnal,
} from "../../api/jurnal";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import {
  AntreanKosong,
  CatatanOtorisasi,
  HalamanModul,
  Muat,
  useLingkupCabang,
  usePilihan,
} from "../shared/parts";
import { KartuRingkas } from "../tools/parts";
import {
  BadgeJurnal,
  CatatanBatas,
  DokumenJurnal,
  KotakPilih,
  labelJenis,
  usePilihanBanyak,
} from "./parts";

export function PostingJurnal({ route }: { route: PageRoute }) {
  const lingkup = useLingkupCabang("Cabang");
  const [dokumenId, setDokumenId] = usePilihan("dokumen");
  const pilih = usePilihanBanyak();
  const [konfirmasiSatu, setKonfirmasiSatu] = useState(false);
  const [konfirmasiBatch, setKonfirmasiBatch] = useState(false);

  const antrean = useApi(
    () => daftarJurnal({ status: "DRAFT", cabangId: lingkup.cabangId }),
    [lingkup.cabangId],
  );
  const dokumen = useApi(() => detailJurnal(dokumenId ?? ""), [dokumenId], {
    enabled: dokumenId !== null,
  });
  const satu = useAction(postingJurnal);
  const batch = useAction(postingBatch);

  const rows = antrean.data?.data ?? [];
  const terpilih = rows.filter((row) => pilih.punya(row.id));

  async function postingSatu() {
    if (!dokumenId) return;
    const hasil = await satu.jalankan(dokumenId);
    if (hasil) {
      setKonfirmasiSatu(false);
      antrean.reload();
      dokumen.reload();
    }
  }

  async function postingSemua() {
    const hasil = await batch.jalankan(terpilih.map((row) => row.id));
    if (hasil) {
      setKonfirmasiBatch(false);
      pilih.kosongkan();
      antrean.reload();
    }
  }

  return (
    <HalamanModul route={route}>
      <div className="filter-laporan">
        {lingkup.kontrol}
        <p className="filter-laporan-catatan">
          Antrean berisi seluruh dokumen berstatus DRAFT pada lingkup ini, termasuk yang dibentuk
          engine. Server menolak posting ke periode yang sudah tertutup berdasarkan tanggal
          transaksi dokumen, bukan berdasarkan tanggal hari ini.
        </p>
      </div>

      <Muat hasil={antrean} judul="antrean posting" sumber="GET /api/jurnal?status=DRAFT">
        {(data) => (
          <>
            <BandPosting rows={data.data} terpilih={terpilih} />

            <Panel
              as="h2"
              title="Draft siap diposting"
              description="Centang beberapa dokumen untuk posting batch, atau pilih satu baris untuk membaca isinya sebelum memposting satuan."
              aside={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    pilih.terpilih.length === data.data.length
                      ? pilih.kosongkan()
                      : pilih.setSemua(data.data.slice(0, MAKS_BATCH_POSTING).map((row) => row.id))
                  }
                >
                  {pilih.terpilih.length === data.data.length
                    ? "Kosongkan pilihan"
                    : `Pilih maksimal ${formatCount(MAKS_BATCH_POSTING)} dokumen`}
                </Button>
              }
              footer={
                <span className="panel-foot-note">
                  Sumber: GET /api/jurnal?status=DRAFT. Posting memerlukan kewenangan jurnal.post.
                </span>
              }
            >
              {data.data.length === 0 ? (
                <AntreanKosong
                  icon="checkCircle"
                  title="Tidak ada draft yang menunggu posting"
                  description="Seluruh dokumen pada lingkup ini sudah masuk buku besar atau sudah dibatalkan."
                />
              ) : (
                <ul className="antrean-posting">
                  {data.data.map((row) => (
                    <li className="antrean-posting-item" key={row.id}>
                      <KotakPilih
                        id={`pilih-${row.id}`}
                        label={`Sertakan ${row.noJurnal} dalam posting batch`}
                        checked={pilih.punya(row.id)}
                        onChange={(aktif) => pilih.ubah(row.id, aktif)}
                      />
                      <button
                        type="button"
                        className="antrean-posting-btn"
                        onClick={() => setDokumenId(row.id)}
                      >
                        <span className="antrean-posting-head">
                          <span className="antrean-posting-no">{row.noJurnal}</span>
                          <BadgeJurnal status={row.status} verifiedAt={row.verifiedAt} />
                        </span>
                        <span className="antrean-posting-sub">
                          {labelJenis(row.jenis)} . {formatDate(row.tanggalTransaksi)} .{" "}
                          {row.cabangKode} . {row.periodeLabel}
                        </span>
                        <span className="antrean-posting-foot">
                          <span className="antrean-posting-ket">
                            {row.keterangan ?? "tanpa keterangan"}
                          </span>
                          <span className="antrean-posting-nilai">
                            {formatMoney(row.totalDebit)}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel
              as="h2"
              title="Posting batch"
              description="Seluruh dokumen yang dicentang diposting dalam satu transaksi. Bila satu dokumen ditolak, tidak ada satu pun yang diposting."
            >
              <DataList
                items={[
                  { label: "Dokumen dicentang", value: formatCount(terpilih.length) },
                  {
                    label: "Total debit dicentang",
                    value: formatTotal(terpilih.map((row) => row.totalDebit)),
                  },
                  {
                    label: "Belum diverifikasi",
                    value: formatCount(terpilih.filter((row) => row.verifiedAt === null).length),
                  },
                  { label: "Batas per batch", value: formatCount(MAKS_BATCH_POSTING) },
                ]}
              />
              <div className="form-actions-row">
                <Button
                  variant="primary"
                  disabled={terpilih.length === 0}
                  leading={<Icon name="check" size={16} />}
                  onClick={() => setKonfirmasiBatch(true)}
                >
                  Posting {formatCount(terpilih.length)} dokumen sekaligus
                </Button>
              </div>
              {batch.error ? (
                <p className="form-error" role="alert">
                  <Icon name="alert" size={16} />
                  <span>
                    {batch.error} Tidak ada satu dokumen pun yang diposting, jadi antrean di atas
                    masih utuh.
                  </span>
                </p>
              ) : null}
              {batch.hasil ? (
                <p className="periksa-ok">
                  <Icon name="check" size={16} />
                  <span>
                    {formatCount(batch.hasil.data.length)} dokumen masuk buku besar dalam satu
                    transaksi.
                  </span>
                </p>
              ) : null}
            </Panel>

            <CatatanBatas jumlah={data.data.length} />
          </>
        )}
      </Muat>

      {dokumenId === null ? null : (
        <Muat hasil={dokumen} judul="isi dokumen" sumber={`GET /api/jurnal/${dokumenId}`}>
          {(data) => (
            <>
              {data.verifiedAt === null ? (
                <p className="periksa-item">
                  <Icon name="alert" size={16} />
                  <span>
                    Dokumen ini belum diverifikasi Checker. Server tetap mengizinkan posting dokumen
                    yang belum diverifikasi, jadi pemeriksaan ini ada pada Anda, bukan pada sistem.
                  </span>
                </p>
              ) : (
                <p className="periksa-ok">
                  <Icon name="check" size={16} />
                  <span>
                    Sudah diverifikasi {data.diverifikasiOleh ?? "petugas lain"} pada{" "}
                    {formatDate(data.verifiedAt)}.
                  </span>
                </p>
              )}
              <DokumenJurnal
                jurnal={data}
                aksi={
                  <>
                    <Button variant="ghost" onClick={() => setDokumenId(null)}>
                      Tutup dokumen
                    </Button>
                    <Button
                      variant="primary"
                      disabled={data.status !== "DRAFT"}
                      leading={<Icon name="check" size={16} />}
                      onClick={() => setKonfirmasiSatu(true)}
                    >
                      Posting dokumen ini
                    </Button>
                  </>
                }
              />

              <ConfirmDialog
                open={konfirmasiSatu}
                title={`Posting ${data.noJurnal} ke buku besar`}
                description="Setelah diposting, dokumen ini tidak bisa diubah maupun dihapus. Koreksinya hanya lewat jurnal pembalik."
                confirmLabel="Posting dokumen"
                tone="danger"
                confirmPhrase={data.noJurnal}
                confirmPhraseLabel="Ketik nomor dokumen untuk mengonfirmasi"
                loading={satu.status === "mengirim"}
                error={satu.error}
                onCancel={() => setKonfirmasiSatu(false)}
                onConfirm={() => void postingSatu()}
              >
                <DataList
                  items={[
                    { label: "Nomor jurnal", value: data.noJurnal },
                    { label: "Tanggal transaksi", value: formatDate(data.tanggalTransaksi) },
                    { label: "Periode", value: data.periodeLabel },
                    { label: "Total debit", value: formatMoney(data.totalDebit) },
                    { label: "Total kredit", value: formatMoney(data.totalKredit) },
                    {
                      label: "Status verifikasi",
                      value:
                        data.verifiedAt === null
                          ? "belum diverifikasi Checker"
                          : `diverifikasi ${formatDate(data.verifiedAt)}`,
                    },
                  ]}
                />
              </ConfirmDialog>
            </>
          )}
        </Muat>
      )}

      <ConfirmDialog
        open={konfirmasiBatch}
        title={`Posting ${formatCount(terpilih.length)} dokumen sekaligus`}
        description="Posting batch bersifat semua atau tidak sama sekali. Bila satu dokumen ditolak, tidak ada satu pun yang masuk buku besar."
        confirmLabel="Posting seluruh dokumen"
        tone="danger"
        confirmPhrase="POSTING BATCH"
        confirmPhraseLabel="Ketik untuk mengonfirmasi"
        loading={batch.status === "mengirim"}
        error={batch.error}
        onCancel={() => setKonfirmasiBatch(false)}
        onConfirm={() => void postingSemua()}
      >
        <ul className="pilihan-list">
          {terpilih.slice(0, 10).map((row) => (
            <li className="pilihan-btn is-statis" key={row.id}>
              <span className="pilihan-judul">{row.noJurnal}</span>
              <span className="pilihan-sub">
                {formatDate(row.tanggalTransaksi)} . {formatMoney(row.totalDebit)}
              </span>
            </li>
          ))}
          {terpilih.length > 10 ? (
            <li className="pilihan-btn is-statis">
              <span className="pilihan-judul">
                dan {formatCount(terpilih.length - 10)} dokumen lain
              </span>
              <span className="pilihan-sub">Seluruhnya ikut dalam satu transaksi yang sama.</span>
            </li>
          ) : null}
        </ul>
      </ConfirmDialog>

      <p className="page-note">
        <Icon name="info" size={16} />
        <span>
          Dua permintaan posting yang bersamaan atas satu dokumen hanya menghasilkan satu dokumen
          POSTED; permintaan yang kalah ditolak dan halaman ini tidak mengulanginya secara otomatis.
          Muat ulang antrean untuk melihat keadaan terbaru.
        </span>
      </p>
      <CatatanOtorisasi tambahan="Posting memerlukan kewenangan jurnal.post." />
    </HalamanModul>
  );
}

function BandPosting({
  rows,
  terpilih,
}: {
  rows: readonly RingkasanJurnal[];
  terpilih: readonly RingkasanJurnal[];
}) {
  const terverifikasi = rows.filter((row) => row.verifiedAt !== null);
  const otomatis = rows.filter((row) => row.isAutoGenerated);
  return (
    <Bento columns={4}>
      <BentoItem span="sm">
        <KartuRingkas
          judul="Draft menunggu"
          nilai={formatCount(rows.length)}
          catatan="Seluruh dokumen DRAFT pada lingkup cabang yang dipilih, termasuk yang dibentuk engine."
        />
      </BentoItem>
      <BentoItem span="sm">
        <KartuRingkas
          judul="Sudah diverifikasi"
          nilai={formatCount(terverifikasi.length)}
          catatan="Engine tidak mensyaratkan verifikasi sebelum posting, jadi ini kendali operasional."
        />
      </BentoItem>
      <BentoItem span="sm">
        <KartuRingkas
          judul="Dibentuk engine"
          nilai={formatCount(otomatis.length)}
          catatan="Dokumen yang dibentuk proses otomatis dan masih berstatus draft pada lingkup ini."
        />
      </BentoItem>
      <BentoItem span="sm">
        <KartuRingkas
          judul="Dicentang"
          nilai={formatCount(terpilih.length)}
          catatan="Dokumen yang akan ikut dalam satu transaksi posting batch berikutnya."
        />
      </BentoItem>
    </Bento>
  );
}

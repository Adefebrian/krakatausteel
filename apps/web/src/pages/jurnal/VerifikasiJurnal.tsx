// Verifikasi Jurnal Draft, spec 9.4. The Checker's queue: every DRAFT waiting
// to be read before an Approver may post it.
//
// THE QUEUE IS `GET /jurnal?status=DRAFT`, THE SAME READ THE DOCUMENT LIST
// MAKES. A second endpoint answering "the drafts" would eventually disagree
// with the list about what a draft is; there is one read, narrowed.
//
// THE SYSTEM REFUSES A MAKER VERIFYING THEIR OWN DOCUMENT, IT DOES NOT MERELY
// HIDE THE BUTTON. Spec 2 rule 1 says so in those words, and the engine answers
// `MAKER_TIDAK_BOLEH_CHECKER`, which core/http.ts maps to 409 SEGREGASI_TUGAS.
// So this page shows the control on a document the signed in user filed, and
// says in advance that the server will refuse it: hiding the button would teach
// an operator that the control does not exist, and the refusal is the evidence
// that the segregation is real rather than cosmetic.
//
// THERE IS NO "KEMBALIKAN KE MAKER" CONTROL, AND ITS ABSENCE IS HONEST. The API
// has one verify route and no reject route; `POST /jurnal/:id/batal` cancels a
// draft and belongs to the Maker's own `jurnal.delete`, not to the Checker.
// Drawing a return control that quietly cancelled someone else's document would
// be inventing a workflow the server does not have, so the page says what a
// Checker actually does with a bad draft: refuse to verify it and tell the
// Maker, who corrects or cancels their own draft.
import { useState } from "react";
import { Bento, BentoItem, Button, ConfirmDialog, Icon, Panel, formatCount, formatDate } from "@krakatausteel/ui";
import { daftarJurnal, detailJurnal, verifikasiJurnal, type RingkasanJurnal } from "../../api/jurnal";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useActiveSession } from "../../session";
import {
  AntreanKosong,
  CatatanOtorisasi,
  HalamanModul,
  Muat,
  useLingkupCabang,
  usePilihan,
} from "../shared/parts";
import { KartuRingkas } from "../tools/parts";
import { CatatanBatas, DaftarJurnalTabel, DokumenJurnal, sudahDiverifikasi } from "./parts";

export function VerifikasiJurnal({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const lingkup = useLingkupCabang("Cabang");
  const [dokumenId, setDokumenId] = usePilihan("dokumen");
  const [konfirmasi, setKonfirmasi] = useState(false);

  const antrean = useApi(
    () => daftarJurnal({ status: "DRAFT", cabangId: lingkup.cabangId, otomatis: false }),
    [lingkup.cabangId],
  );
  const dokumen = useApi(() => detailJurnal(dokumenId ?? ""), [dokumenId], {
    enabled: dokumenId !== null,
  });
  const verifikasi = useAction(verifikasiJurnal);

  const isi = dokumen.data;
  const milikSendiri = isi !== null && isi.dibuatOleh === session.user.nama;
  const sudah = isi !== null && sudahDiverifikasi(isi);

  async function jalankan() {
    if (!dokumenId) return;
    const hasil = await verifikasi.jalankan(dokumenId);
    if (hasil) {
      setKonfirmasi(false);
      antrean.reload();
      dokumen.reload();
    }
  }

  return (
    <HalamanModul route={route}>
      <div className="filter-laporan">
        {lingkup.kontrol}
        <p className="filter-laporan-catatan">
          Antrean ini hanya berisi dokumen berstatus DRAFT yang diinput orang. Jurnal yang dibentuk
          engine tidak melewati verifikasi manual dan tidak muncul di sini.
        </p>
      </div>

      <Muat hasil={antrean} judul="antrean verifikasi" sumber="GET /api/jurnal?status=DRAFT">
        {(data) => (
          <>
            <BandAntrean rows={data.data} />
            <Panel
              as="h2"
              title="Draft menunggu verifikasi"
              description="Pilih satu dokumen untuk membaca barisnya sebelum memutuskan."
              footer={
                <span className="panel-foot-note">
                  Sumber: GET /api/jurnal?status=DRAFT. Kewenangan jurnal.view untuk membaca,
                  jurnal.verify untuk memverifikasi.
                </span>
              }
            >
              {data.data.length === 0 ? (
                <AntreanKosong
                  icon="checkCircle"
                  title="Tidak ada draft yang menunggu"
                  description="Setiap jurnal manual pada cabang ini sudah diverifikasi atau sudah diposting."
                />
              ) : (
                <DaftarJurnalTabel
                  rows={data.data}
                  onPilih={(row) => setDokumenId(row.id)}
                  emptyTitle="Tidak ada draft yang menunggu"
                  emptyDescription="Setiap jurnal manual pada cabang ini sudah diverifikasi atau sudah diposting."
                  caption="Antrean verifikasi jurnal draft"
                />
              )}
            </Panel>
            <CatatanBatas jumlah={data.data.length} />
          </>
        )}
      </Muat>

      {dokumenId === null ? (
        <Panel as="h2" title="Belum ada dokumen dipilih">
          <AntreanKosong
            icon="jurnal"
            title="Pilih satu draft dari antrean"
            description="Isi dokumen, baris demi baris, muncul di sini begitu satu baris antrean dipilih."
          />
        </Panel>
      ) : (
        <Muat hasil={dokumen} judul="isi dokumen" sumber={`GET /api/jurnal/${dokumenId}`}>
          {(data) => (
            <>
              {sudah ? (
                <p className="periksa-ok">
                  <Icon name="check" size={16} />
                  <span>
                    Dokumen ini sudah diverifikasi oleh {data.diverifikasiOleh ?? "petugas lain"}{" "}
                    pada {formatDate(data.verifiedAt)}. Langkah berikutnya adalah posting oleh
                    Approver.
                  </span>
                </p>
              ) : milikSendiri ? (
                <p className="periksa-item">
                  <Icon name="alert" size={16} />
                  <span>
                    Dokumen ini Anda sendiri yang membuatnya. Server menolak verifikasi oleh pembuat
                    dokumen yang sama, dan penolakannya tercatat pada audit log. Tombolnya tetap
                    ditampilkan supaya aturan ini terlihat, bukan disembunyikan.
                  </span>
                </p>
              ) : null}

              <DokumenJurnal
                jurnal={data}
                aksi={
                  <>
                    <Button variant="ghost" onClick={() => setDokumenId(null)}>
                      Tutup dokumen
                    </Button>
                    <Button
                      variant="primary"
                      disabled={sudah}
                      leading={<Icon name="check" size={16} />}
                      onClick={() => setKonfirmasi(true)}
                    >
                      Verifikasi dokumen ini
                    </Button>
                  </>
                }
              />

              <ConfirmDialog
                open={konfirmasi}
                title={`Verifikasi ${data.noJurnal}`}
                description="Verifikasi menyatakan bahwa Anda sudah membaca dokumen ini dan isinya benar. Verifikasi tidak memposting dokumen ke buku besar."
                confirmLabel="Verifikasi dokumen"
                loading={verifikasi.status === "mengirim"}
                error={verifikasi.error}
                onCancel={() => setKonfirmasi(false)}
                onConfirm={() => void jalankan()}
              >
                <ul className="langkah-list">
                  <li>Status dokumen tetap DRAFT, dengan catatan siapa yang memverifikasi dan kapan.</li>
                  <li>Posting ke buku besar tetap tindakan terpisah, dilakukan Approver.</li>
                  <li>Bila Anda pembuat dokumen ini, server akan menolak dengan alasan segregasi tugas.</li>
                </ul>
              </ConfirmDialog>
            </>
          )}
        </Muat>
      )}

      <p className="page-note">
        <Icon name="info" size={16} />
        <span>
          Tidak ada tombol kembalikan ke Maker di halaman ini karena server tidak punya jalurnya.
          Draft yang salah tidak diverifikasi, lalu Maker memperbaiki atau membatalkan draftnya
          sendiri di halaman input.
        </span>
      </p>
      <CatatanOtorisasi tambahan="Verifikasi memerlukan kewenangan jurnal.verify." />
    </HalamanModul>
  );
}

function BandAntrean({ rows }: { rows: readonly RingkasanJurnal[] }) {
  const belum = rows.filter((row) => row.verifiedAt === null);
  return (
    <Bento columns={3}>
      <BentoItem span="sm">
        <KartuRingkas
          judul="Draft di antrean"
          nilai={formatCount(rows.length)}
          catatan="Dokumen berstatus DRAFT yang diinput orang pada lingkup cabang yang dipilih."
        />
      </BentoItem>
      <BentoItem span="sm">
        <KartuRingkas
          judul="Belum diverifikasi"
          nilai={formatCount(belum.length)}
          catatan="Menunggu dibaca Checker. Verifikasi tidak memposting apa pun ke buku besar."
        />
      </BentoItem>
      <BentoItem span="sm">
        <KartuRingkas
          judul="Sudah diverifikasi"
          nilai={formatCount(rows.length - belum.length)}
          catatan="Sudah dibaca Checker dan menunggu posting oleh Approver."
        />
      </BentoItem>
    </Bento>
  );
}

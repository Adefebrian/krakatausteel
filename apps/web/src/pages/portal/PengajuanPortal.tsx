// Pengajuan PUMK Online and Pengajuan Non PUMK Online, spec 9.5. One
// implementation, two routes: the only thing that differs is which `jenis` the
// queue is narrowed to, and the server tells the page what each submission
// contains.
//
// IT READS AND IT DOES NOT ACT. Both routes behind it are GETs on
// `portal.view`, which is the code an intake officer and an Auditor both hold
// and which grants no power to verify, refuse or convert. Deciding on a
// submission is ./VerifikasiKonversi.tsx, gated on `portal.konversi`, and this
// page links there rather than growing a second copy of those controls: two
// screens that can both refuse a submission would eventually disagree about
// what refusing means.
//
// THE APPLICANT'S OWN WORDS ARE SHOWN UNEDITED. Nothing on this page normalises
// a name, trims an address or fills in a missing field. An officer comparing a
// submission against a paper form has to see exactly what was typed, and a
// field the applicant left blank says so rather than showing an empty cell.
import { useState } from "react";
import { Bento, BentoItem, Button, Icon, Panel, formatCount } from "@krakatausteel/ui";
import {
  daftarSubmission,
  detailSubmission,
  STATUS_SUBMISSION,
  LABEL_STATUS_SUBMISSION,
  type JenisPengajuan,
  type RingkasanSubmission,
  type StatusSubmission,
} from "../../api/portal-staf";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { Link } from "../../router";
import {
  CatatanOtorisasi,
  DaftarDokumen,
  HalamanModul,
  Muat,
  Penyaring,
  useLayarKecil,
  usePilihan,
} from "../shared/parts";
import { KartuRingkas } from "../tools/parts";
import {
  CatatanPortal,
  DokumenSubmission,
  kartuSubmission,
  kolomSubmission,
} from "./parts";
import { SearchInput, Select } from "@krakatausteel/ui";

export function PengajuanPortal({
  route,
  jenis,
}: {
  route: PageRoute;
  jenis: JenisPengajuan;
}) {
  const kecil = useLayarKecil();
  const [submissionId, setSubmissionId] = usePilihan("submission");
  const [status, setStatus] = useState("");
  const [tiket, setTiket] = useState("");

  const antrean = useApi(
    () =>
      daftarSubmission({
        jenis,
        status: (status || null) as StatusSubmission | null,
        noTiket: tiket.trim() || null,
      }),
    [jenis, status, tiket],
  );
  const detail = useApi(() => detailSubmission(submissionId ?? ""), [submissionId], {
    enabled: submissionId !== null,
  });

  const isiFilter = (
    <div className="filter-laporan">
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Status</span>
        <Select
          aria-label="Status submission"
          value={status}
          onChange={(event) => setStatus(event.currentTarget.value)}
          options={[
            { value: "", label: "Semua status" },
            ...STATUS_SUBMISSION.map((value) => ({
              value,
              label: LABEL_STATUS_SUBMISSION[value] ?? value,
            })),
          ]}
        />
      </label>
      <label className="filter-laporan-group is-lebar">
        <span className="filter-laporan-label">Cari nomor tiket</span>
        <SearchInput
          label="Cari nomor tiket"
          value={tiket}
          onChange={(event) => setTiket(event.currentTarget.value)}
        />
      </label>
      <p className="filter-laporan-catatan">
        Daftar ini sudah dipersempit server ke entitas sesi Anda. Submission milik entitas lain
        tidak pernah muncul di sini, dan itu bukan hasil filter di halaman ini.
      </p>
    </div>
  );

  return (
    <HalamanModul route={route}>
      {kecil ? (
        <Penyaring
          ringkas={`${status === "" ? "semua status" : (LABEL_STATUS_SUBMISSION[status] ?? status)}`}
        >
          {isiFilter}
        </Penyaring>
      ) : (
        isiFilter
      )}

      <Muat
        hasil={antrean}
        judul="daftar submission portal"
        sumber={`GET /api/portal/submission?jenis=${jenis}`}
      >
        {(data) => (
          <>
            <BandSubmission rows={data.data} />
            <Panel
              as="h2"
              title="Submission masuk"
              description="Urut sesuai jawaban server. Pilih satu baris untuk membaca isian pemohon selengkapnya."
              footer={
                <span className="panel-foot-note">
                  Sumber: GET /api/portal/submission. Kewenangan portal.view, yang tidak memberi
                  hak memverifikasi maupun mengonversi.
                </span>
              }
            >
              <DaftarDokumen
                columns={kolomSubmission()}
                rows={data.data}
                rowKey={(row) => row.id}
                kartu={kartuSubmission}
                onPilih={(row) => setSubmissionId(row.id)}
                emptyTitle="Belum ada submission pada filter ini"
                emptyDescription="Longgarkan filter status, atau kosongkan pencarian nomor tiket."
                caption="Submission dari portal publik"
              />
            </Panel>
          </>
        )}
      </Muat>

      {submissionId === null ? null : (
        <Muat
          hasil={detail}
          judul="isi submission"
          sumber={`GET /api/portal/submission/${submissionId}`}
        >
          {(data) => (
            <DokumenSubmission
              submission={data}
              aksi={
                <>
                  <Button
                    variant="ghost"
                    leading={<Icon name="close" size={16} />}
                    onClick={() => setSubmissionId(null)}
                  >
                    Tutup submission
                  </Button>
                  <Link
                    className="tautan-dokumen"
                    to={`/portal/verifikasi?submission=${encodeURIComponent(data.id)}`}
                  >
                    Buka di Verifikasi dan Konversi
                  </Link>
                </>
              }
            />
          )}
        </Muat>
      )}

      <CatatanPortal />
      <CatatanOtorisasi tambahan="Halaman ini memerlukan kewenangan portal.view. Memverifikasi dan mengonversi memerlukan portal.konversi." />
    </HalamanModul>
  );
}

function BandSubmission({ rows }: { rows: readonly RingkasanSubmission[] }) {
  const hitung = (status: string) => rows.filter((row) => row.status === status).length;
  return (
    <Bento columns={4}>
      <BentoItem span="sm">
        <KartuRingkas
          judul="Submission tampil"
          nilai={formatCount(rows.length)}
          catatan="Jumlah submission pada filter yang sedang aktif, bukan seluruh riwayat portal."
        />
      </BentoItem>
      <BentoItem span="sm">
        <KartuRingkas
          judul="Baru masuk"
          nilai={formatCount(hitung("BARU"))}
          catatan="Belum disentuh petugas mana pun. Pemohon masih membaca status ini di portal publik."
        />
      </BentoItem>
      <BentoItem span="sm">
        <KartuRingkas
          judul="Sedang diproses"
          nilai={formatCount(hitung("DIPROSES"))}
          catatan="Sudah diverifikasi petugas dan siap dipertimbangkan untuk dikonversi menjadi proposal."
        />
      </BentoItem>
      <BentoItem span="sm">
        <KartuRingkas
          judul="Dikonversi dan ditolak"
          nilai={`${formatCount(hitung("DIKONVERSI"))} dan ${formatCount(hitung("DITOLAK"))}`}
          catatan="Submission yang sudah menjadi proposal internal, dan yang ditolak beserta alasannya."
        />
      </BentoItem>
    </Bento>
  );
}

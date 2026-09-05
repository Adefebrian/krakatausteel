// Verifikasi dan Konversi Submission, spec 9.5. The officer's decision on a
// public submission, and the one act that turns it into an internal proposal.
//
// TWO ACTS, TWO ENDPOINTS, TWO MODULES, AND THE PAGE KEEPS THEM APART.
//
//   `POST /portal/submission/:id/tindak` marks a submission DIPROSES or
//   DITOLAK. It CANNOT set DIKONVERSI, and the portal engine refuses that value
//   outright, because a status claiming a proposal exists must not be settable
//   by anything that cannot create one.
//
//   `POST /pumk/portal/konversi` creates the proposal, links it back to the
//   submission, and is what actually sets DIKONVERSI. It lives on modules/pumk
//   because that module owns proposals.
//
// SO CONVERSION ASKS FOR A MITRA, AND THAT IS NOT A FORM FIELD THIS PAGE
// INVENTED. `KonversiPortalInput` requires `mitraId`: a public submission is a
// stranger's form, and a proposal belongs to a Mitra Binaan on the books. The
// officer matches the applicant against an existing mitra, and if there is none
// the mitra is created first on its own screen. Creating one silently from a
// public form would put an unverified identity into master data.
//
// CONVERSION IS NOT REVERSIBLE FROM HERE. A converted submission has a proposal
// behind it; undoing that is the proposal's own lifecycle, not a button on the
// intake queue. The page says so before the click and shows the resulting
// proposal afterwards.
import { useState } from "react";
import {
  Button,
  ConfirmDialog,
  DataList,
  Field,
  Icon,
  Panel,
  SearchInput,
  Select,
  Textarea,
  TextInput,
  formatDate,
  formatMoney,
} from "@krakatausteel/ui";
import {
  daftarSubmission,
  detailSubmission,
  konversiSubmissionPortal,
  tindakSubmission,
  type DetailSubmission,
} from "../../api/portal-staf";
import { cariMitra, daftarSektor } from "../../api/pumk";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { Link } from "../../router";
import { useActiveSession } from "../../session";
import {
  AntreanKosong,
  CatatanOtorisasi,
  DaftarDokumen,
  FieldGrid,
  HalamanModul,
  hariIni,
  Muat,
  usePilihan,
} from "../shared/parts";
import {
  BadgeSubmission,
  CatatanPortal,
  DokumenSubmission,
  kartuSubmission,
  kolomSubmission,
} from "./parts";

export function VerifikasiKonversi({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const [submissionId, setSubmissionId] = usePilihan("submission");

  const antrean = useApi(() => daftarSubmission({}), []);
  const detail = useApi(() => detailSubmission(submissionId ?? ""), [submissionId], {
    enabled: submissionId !== null,
  });

  return (
    <HalamanModul route={route}>
      <Muat hasil={antrean} judul="antrean submission" sumber="GET /api/portal/submission">
        {(data) => (
          <Panel
            as="h2"
            title="Submission yang menunggu keputusan"
            description="Seluruh submission entitas Anda, apa pun jenis dan statusnya. Pilih satu untuk memutuskan."
            footer={
              <span className="panel-foot-note">
                Sumber: GET /api/portal/submission. Keputusan memerlukan kewenangan
                portal.konversi.
              </span>
            }
          >
            <DaftarDokumen
              columns={kolomSubmission()}
              rows={data.data}
              rowKey={(row) => row.id}
              kartu={kartuSubmission}
              onPilih={(row) => setSubmissionId(row.id)}
              emptyTitle="Tidak ada submission dari portal"
              emptyDescription="Submission baru muncul di sini segera setelah pemohon mengirim formulir publik."
              caption="Antrean verifikasi dan konversi"
            />
          </Panel>
        )}
      </Muat>

      {submissionId === null ? (
        <Panel as="h2" title="Belum ada submission dipilih">
          <AntreanKosong
            icon="portal"
            title="Pilih satu submission dari antrean"
            description="Isian pemohon, keputusan verifikasi, dan formulir konversi muncul di sini setelah satu baris dipilih."
          />
        </Panel>
      ) : (
        <Muat
          hasil={detail}
          judul="isi submission"
          sumber={`GET /api/portal/submission/${submissionId}`}
        >
          {(data) => (
            <>
              <DokumenSubmission
                submission={data}
                aksi={
                  <Button variant="ghost" onClick={() => setSubmissionId(null)}>
                    Tutup submission
                  </Button>
                }
              />
              <Keputusan
                submission={data}
                onSelesai={() => {
                  antrean.reload();
                  detail.reload();
                }}
              />
              <Konversi
                submission={data}
                cabangBawaan={session.cabang.id}
                onSelesai={() => {
                  antrean.reload();
                  detail.reload();
                }}
              />
            </>
          )}
        </Muat>
      )}

      <CatatanPortal />
      <CatatanOtorisasi tambahan="Halaman ini memerlukan kewenangan portal.konversi." />
    </HalamanModul>
  );
}

// ---------------------------------------------------------------------------
// Step one: verify or refuse
// ---------------------------------------------------------------------------

const OPSI_TINDAKAN = [
  { value: "DIPROSES", label: "Verifikasi, lanjut diproses" },
  { value: "DITOLAK", label: "Tolak submission ini" },
];

function Keputusan({
  submission,
  onSelesai,
}: {
  submission: DetailSubmission;
  onSelesai: () => void;
}) {
  const [tindakan, setTindakan] = useState<"DIPROSES" | "DITOLAK">("DIPROSES");
  const [catatan, setCatatan] = useState("");
  const [konfirmasi, setKonfirmasi] = useState(false);
  const aksi = useAction((input: { tindakan: "DIPROSES" | "DITOLAK"; catatan: string | null }) =>
    tindakSubmission(submission.id, input),
  );

  const selesai = submission.status === "DIKONVERSI";
  const wajibAlasan = tindakan === "DITOLAK" && catatan.trim().length === 0;

  async function jalankan() {
    const hasil = await aksi.jalankan({
      tindakan,
      catatan: catatan.trim() === "" ? null : catatan.trim(),
    });
    if (hasil) {
      setKonfirmasi(false);
      onSelesai();
    }
  }

  return (
    <Panel
      as="h2"
      title="Keputusan verifikasi"
      description="Verifikasi menandai submission sudah diperiksa petugas. Penolakan beserta alasannya bisa dibaca pemohon lewat cek status di portal publik."
      aside={<BadgeSubmission status={submission.status} />}
    >
      {selesai ? (
        <p className="periksa-ok">
          <Icon name="check" size={16} />
          <span>
            Submission ini sudah dikonversi menjadi proposal internal, jadi statusnya tidak diubah
            lagi dari halaman ini.
          </span>
        </p>
      ) : (
        <>
          <FieldGrid>
            <Field label="Tindakan" htmlFor="portal-tindakan" required>
              <Select
                id="portal-tindakan"
                value={tindakan}
                onChange={(event) =>
                  setTindakan(event.currentTarget.value as "DIPROSES" | "DITOLAK")
                }
                options={OPSI_TINDAKAN}
              />
            </Field>
          </FieldGrid>
          <Field
            label="Catatan petugas"
            htmlFor="portal-catatan"
            required={tindakan === "DITOLAK"}
            error={
              wajibAlasan && catatan !== ""
                ? "Alasan penolakan wajib diisi."
                : undefined
            }
            hint={
              tindakan === "DITOLAK"
                ? "Alasan penolakan dibaca pemohon di portal publik, jadi tulis dalam kalimat yang bisa mereka tindaklanjuti."
                : "Opsional. Catatan tersimpan pada submission dan terbaca petugas lain."
            }
          >
            <Textarea
              id="portal-catatan"
              rows={3}
              maxLength={1000}
              value={catatan}
              onChange={(event) => setCatatan(event.currentTarget.value)}
            />
          </Field>
          <div className="form-actions-row">
            <Button
              variant={tindakan === "DITOLAK" ? "danger" : "primary"}
              disabled={wajibAlasan}
              leading={<Icon name={tindakan === "DITOLAK" ? "close" : "check"} size={16} />}
              onClick={() => setKonfirmasi(true)}
            >
              {tindakan === "DITOLAK" ? "Tolak submission" : "Tandai sudah diverifikasi"}
            </Button>
          </div>
          {aksi.error ? (
            <p className="form-error" role="alert">
              <Icon name="alert" size={16} />
              <span>{aksi.error}</span>
            </p>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={konfirmasi}
        title={
          tindakan === "DITOLAK"
            ? `Tolak submission ${submission.noTiket}`
            : `Verifikasi submission ${submission.noTiket}`
        }
        description={
          tindakan === "DITOLAK"
            ? "Penolakan beserta catatannya bisa dibaca pemohon lewat cek status di portal publik."
            : "Verifikasi tidak membuat proposal. Membuat proposal adalah langkah konversi di bawah."
        }
        confirmLabel={tindakan === "DITOLAK" ? "Tolak submission" : "Verifikasi"}
        tone={tindakan === "DITOLAK" ? "danger" : "primary"}
        loading={aksi.status === "mengirim"}
        error={aksi.error}
        onCancel={() => setKonfirmasi(false)}
        onConfirm={() => void jalankan()}
      >
        <DataList
          items={[
            { label: "Nomor tiket", value: submission.noTiket },
            { label: "Pemohon", value: submission.namaPemohon ?? "tidak diisi pemohon" },
            {
              label: "Catatan yang tersimpan",
              value: catatan.trim() === "" ? "tanpa catatan" : catatan.trim(),
              wide: true,
            },
          ]}
        />
      </ConfirmDialog>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Step two: become a proposal
// ---------------------------------------------------------------------------

function Konversi({
  submission,
  cabangBawaan,
  onSelesai,
}: {
  submission: DetailSubmission;
  cabangBawaan: string;
  onSelesai: () => void;
}) {
  const session = useActiveSession();
  const [cabangId, setCabangId] = useState(cabangBawaan);
  const [cari, setCari] = useState(submission.namaPemohon ?? "");
  const [mitraId, setMitraId] = useState("");
  const [sektorId, setSektorId] = useState("");
  const [tanggal, setTanggal] = useState(hariIni());
  const [catatan, setCatatan] = useState("");
  const [konfirmasi, setKonfirmasi] = useState(false);

  const mitra = useApi(() => cariMitra(cari.trim(), cabangId), [cari, cabangId]);
  const sektor = useApi(() => daftarSektor(), []);
  const aksi = useAction(konversiSubmissionPortal);

  const sudah = submission.status === "DIKONVERSI";
  const siap = mitraId !== "" && cabangId !== "" && tanggal !== "";
  const pilihanMitra = mitra.data?.data ?? [];

  async function jalankan() {
    const hasil = await aksi.jalankan({
      submissionId: submission.id,
      cabangId,
      mitraId,
      sektorId: sektorId === "" ? null : sektorId,
      tanggalProposal: tanggal,
      catatanPetugas: catatan.trim() === "" ? null : catatan.trim(),
    });
    if (hasil) {
      setKonfirmasi(false);
      onSelesai();
    }
  }

  if (sudah || aksi.hasil) {
    const proposalId = aksi.hasil?.id ?? submission.convertedProposalId;
    return (
      <Panel
        as="h2"
        title="Submission sudah menjadi proposal internal"
        description="Tautan dua arah antara submission dan proposal tersimpan, jadi asal usul proposal ini tetap terbaca."
      >
        <DataList
          items={[
            { label: "Nomor tiket", value: submission.noTiket },
            { label: "Proposal hasil konversi", value: proposalId ?? "belum tercatat" },
            { label: "Sumber pengajuan proposal", value: "PORTAL_ONLINE" },
          ]}
        />
        {proposalId ? (
          <div className="form-actions-row">
            <Link
              className="tautan-dokumen"
              to={`/pumk/proposal/${encodeURIComponent(proposalId)}`}
            >
              Buka proposal hasil konversi
            </Link>
          </div>
        ) : null}
      </Panel>
    );
  }

  return (
    <Panel
      as="h2"
      title="Konversi menjadi proposal internal"
      description="Konversi membuat proposal PUMK dengan sumber pengajuan PORTAL_ONLINE, dan menautkannya kembali ke submission ini."
      footer={
        <span className="panel-foot-note">
          Sumber: POST /api/pumk/portal/konversi. Kewenangan portal.konversi.
        </span>
      }
    >
      <p className="page-note">
        <Icon name="info" size={16} />
        <span>
          Proposal selalu dimiliki satu Mitra Binaan yang sudah terdaftar. Bila pemohon belum
          terdaftar, daftarkan dulu sebagai Mitra Binaan, lalu kembali ke halaman ini. Sistem sengaja
          tidak membuat mitra baru dari formulir publik, karena identitas dari portal belum
          diverifikasi petugas.
        </span>
      </p>

      <FieldGrid>
        <Field label="Cabang pemilik proposal" htmlFor="konversi-cabang" required>
          <Select
            id="konversi-cabang"
            value={cabangId}
            onChange={(event) => {
              setCabangId(event.currentTarget.value);
              setMitraId("");
            }}
            options={session.cabangTersedia.map((cabang) => ({
              value: cabang.id,
              label: `${cabang.kode} ${cabang.nama}`,
            }))}
          />
        </Field>
        <Field label="Tanggal proposal" htmlFor="konversi-tanggal" required>
          <TextInput
            id="konversi-tanggal"
            type="date"
            value={tanggal}
            onChange={(event) => setTanggal(event.currentTarget.value)}
          />
        </Field>
        <Field
          label="Sektor usaha"
          htmlFor="konversi-sektor"
          hint={`Pemohon menulis sektor "${String(submission.formulir.sektor ?? "tidak diisi")}" pada formulir publik.`}
        >
          <Select
            id="konversi-sektor"
            value={sektorId}
            disabled={sektor.status !== "siap"}
            onChange={(event) => setSektorId(event.currentTarget.value)}
            options={[
              { value: "", label: "Belum ditentukan" },
              ...(sektor.data?.data ?? []).map((item) => ({
                value: item.id,
                label: `${item.kode} ${item.nama}`,
              })),
            ]}
          />
        </Field>
        <Field label="Cari Mitra Binaan" htmlFor="konversi-cari">
          <SearchInput
            id="konversi-cari"
            label="Cari Mitra Binaan berdasarkan nama, NIK, atau kode"
            value={cari}
            onChange={(event) => setCari(event.currentTarget.value)}
          />
        </Field>
      </FieldGrid>

      <ul className="pilihan-list">
        {pilihanMitra.length === 0 ? (
          <li className="pilihan-btn is-statis">
            <span className="pilihan-judul">Tidak ada Mitra Binaan yang cocok</span>
            <span className="pilihan-sub">
              Ganti kata kunci, atau daftarkan pemohon sebagai Mitra Binaan terlebih dahulu.
            </span>
          </li>
        ) : (
          pilihanMitra.slice(0, 12).map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={mitraId === item.id ? "pilihan-btn is-active" : "pilihan-btn"}
                onClick={() => setMitraId(item.id)}
              >
                <span className="pilihan-judul">{item.namaLengkap}</span>
                <span className="pilihan-sub">
                  {item.kodeMitra} . {item.namaUsaha ?? "tanpa nama usaha"}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>

      <Field label="Catatan petugas pada proposal" htmlFor="konversi-catatan">
        <Textarea
          id="konversi-catatan"
          rows={2}
          maxLength={1000}
          value={catatan}
          onChange={(event) => setCatatan(event.currentTarget.value)}
        />
      </Field>

      <div className="form-actions-row">
        <Button
          variant="primary"
          disabled={!siap}
          leading={<Icon name="arrowRight" size={16} />}
          onClick={() => setKonfirmasi(true)}
        >
          Konversi menjadi proposal
        </Button>
      </div>
      {aksi.error ? (
        <p className="form-error" role="alert">
          <Icon name="alert" size={16} />
          <span>{aksi.error}</span>
        </p>
      ) : null}

      <ConfirmDialog
        open={konfirmasi}
        title={`Konversi ${submission.noTiket} menjadi proposal`}
        description="Proposal internal terbentuk dan tertaut ke submission ini. Konversi tidak bisa dibatalkan dari halaman ini."
        confirmLabel="Konversi menjadi proposal"
        loading={aksi.status === "mengirim"}
        error={aksi.error}
        onCancel={() => setKonfirmasi(false)}
        onConfirm={() => void jalankan()}
      >
        <DataList
          items={[
            { label: "Nomor tiket", value: submission.noTiket },
            { label: "Tanggal masuk", value: formatDate(submission.tanggalSubmit) },
            {
              label: "Jumlah yang diajukan pemohon",
              value:
                submission.jumlahDiajukan === null
                  ? "tidak diisi pemohon"
                  : formatMoney(submission.jumlahDiajukan),
              numeric: true,
            },
            {
              label: "Mitra Binaan pemilik proposal",
              value:
                pilihanMitra.find((item) => item.id === mitraId)?.namaLengkap ?? "belum dipilih",
              wide: true,
            },
          ]}
        />
      </ConfirmDialog>
    </Panel>
  );
}

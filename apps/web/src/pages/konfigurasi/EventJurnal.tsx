// Event Journal Mapping, spec 9.4 and ADR 0004. The one place that decides
// what every automatic journal debits and credits.
//
// THIS SCREEN IS NOT A FORM, AND IT IS DRAWN SO THAT NOBODY MISTAKES IT FOR ONE.
//
// One row here decides what every future journal of an event does. Repointing
// PENCAIRAN_PUMK's debit posts cleanly, balances, keeps every integrity check
// green, and quietly stops the entity having receivables. The demo world
// already produced one defect of exactly that class, and forty six green checks
// did not see it, because what was wrong was the classification and not the
// arithmetic. Arithmetic cannot be the control. A second pair of eyes can.
//
// SO THE SHAPE IS A MAKER-CHECKER AND THE PAGE LEADS WITH IT:
//
//   THE PROPOSAL QUEUE IS THE FIRST THING ON THE PAGE, above the mappings in
//   force, because the decision waiting for somebody is the work.
//
//   EVERY PROPOSAL IS RENDERED AS A DIFF, never as a form full of values. The
//   left column is the mapping that was in force AT THE MOMENT THE PROPOSAL WAS
//   FILED, frozen into the proposal row by the server (`mapping_sebelum_json`),
//   and the right column is what is being asked for. The approver approves the
//   change that was reviewed, not whatever the current state happens to be.
//
//   APPROVING YOUR OWN PROPOSAL IS NOT OFFERED. The server refuses it with a
//   segregation of duties refusal and `trg_ejm_usulan_10_sod` refuses it again
//   in the database. On your own proposal this screen offers WITHDRAWAL
//   instead, which is the act the API actually gives the author, and says why.
//
//   FILING A PROPOSAL CHANGES NOTHING, AND THE PAGE SAYS SO. The posting path
//   reads only the active row in `event_jurnal_mapping`; a pending proposal
//   lives in a table the engine cannot see. That is what makes it safe to file
//   one and wait.
//
// THE EVENT VOCABULARY IS NOT OPEN, AND THIS SCREEN DOES NOT PRETEND IT IS. An
// event code is the journal engine's own vocabulary and is introduced by the
// seed, not by a user: an unknown event is a bug, an unknown account is a
// configuration choice (ADR 0004). So the event is CHOSEN from the events this
// entity already knows, never typed.
import { useMemo, useState } from "react";
import {
  Button,
  ConfirmDialog,
  DataList,
  Field,
  Icon,
  Panel,
  Select,
  StatusBadge,
  Textarea,
  formatCount,
  formatDate,
} from "@krakatausteel/ui";
import { daftarAkun, type AkunTampil } from "../../api/konfigurasi";
import {
  ajukanMapping,
  batalUsulan,
  daftarMapping,
  daftarUsulanMapping,
  mappingSebelum,
  setujuiUsulan,
  tolakUsulan,
  type MappingTampil,
  type UsulanTampil,
} from "../../api/mapping";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { hasPermission } from "../../permissions";
import { useActiveSession } from "../../session";
import { CatatanOtorisasi, FieldGrid, HalamanModul, Muat } from "../shared/parts";
import { Berhasil, PapanAngka, Penolakan } from "./parts";

const JENIS_JURNAL = [
  "OTOMATIS",
  "KAS_BANK",
  "UMUM",
  "PINBUK",
  "PENYISIHAN",
  "AKRUAL",
  "REVERSAL",
  "CLOSING",
  "SALDO_AWAL",
] as const;

const TONE_USULAN: Record<string, "info" | "success" | "danger" | "neutral"> = {
  DIAJUKAN: "info",
  DISETUJUI: "success",
  DITOLAK: "danger",
  DIBATALKAN: "neutral",
};

const LABEL_USULAN: Record<string, string> = {
  DIAJUKAN: "Menunggu keputusan",
  DISETUJUI: "Disetujui",
  DITOLAK: "Ditolak",
  DIBATALKAN: "Ditarik pengusul",
};

export function EventJurnal({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const bolehTulis = hasPermission(session.permissions, "konfigurasi.mapping") && !session.readOnly;
  const bolehBacaAkun = hasPermission(session.permissions, "konfigurasi.coa");

  const mapping = useApi(() => daftarMapping(), []);
  const usulan = useApi(() => daftarUsulanMapping(), []);
  const akun = useApi(() => daftarAkun(), [], { enabled: bolehBacaAkun });

  const [formBaru, setFormBaru] = useState(false);

  // Account id to NAME, and deliberately not to "kode nama". The code printed
  // on a proposal must always be the code stored ON THAT PROPOSAL, so that the
  // screen can never quietly show a different account than the row names; the
  // chart is consulted for the name alone, which is an annotation.
  const namaAkun = useMemo(() => {
    const peta = new Map<string, string>();
    for (const row of akun.data?.data ?? []) peta.set(row.id, row.nama);
    return peta;
  }, [akun.data]);

  const semuaUsulan = usulan.data?.data ?? [];
  const menunggu = semuaUsulan.filter((row) => row.status === "DIAJUKAN");
  const diputus = semuaUsulan.filter((row) => row.status !== "DIAJUKAN");

  function segarkan() {
    mapping.reload();
    usulan.reload();
  }

  return (
    <HalamanModul
      route={route}
      actions={
        bolehTulis ? (
          <Button
            variant="primary"
            leading={<Icon name="plus" size={16} />}
            onClick={() => setFormBaru((buka) => !buka)}
          >
            {formBaru ? "Tutup formulir usulan" : "Ajukan perubahan"}
          </Button>
        ) : undefined
      }
    >
      <Muat hasil={mapping} judul="pemetaan event jurnal" sumber="GET /api/jurnal/mapping">
        {(data) => (
          <>
            <PapanAngka
              items={[
                {
                  label: "Pemetaan berlaku",
                  nilai: formatCount(data.data.length),
                  satuan: "Event",
                  catatan: "Satu baris yang berlaku untuk setiap event.",
                },
                {
                  label: "Event tanpa pemetaan",
                  nilai: formatCount(data.tanpaPemetaan.length),
                  satuan: "Event",
                  catatan: "Event seperti ini tidak dapat memposting jurnal sama sekali.",
                },
                {
                  label: "Menunggu keputusan",
                  nilai: formatCount(menunggu.length),
                  satuan: "Usulan",
                  catatan: "Harus diputus oleh orang selain pengusulnya.",
                },
                {
                  label: "Sudah diputus",
                  nilai: formatCount(diputus.length),
                  satuan: "Usulan",
                  catatan: "Disetujui, ditolak, atau ditarik pengusulnya.",
                },
              ]}
            />

            <PenjelasanMakerChecker />

            {data.tanpaPemetaan.length > 0 ? (
              <Panel
                as="h2"
                title="Event yang tidak punya pemetaan berlaku"
                description="Selama tidak ada pemetaan yang berlaku, setiap transaksi event ini gagal memposting jurnal."
              >
                <ul className="event-kosong-list">
                  {data.tanpaPemetaan.map((kode) => (
                    <li className="event-kosong-item" key={kode}>
                      <span className="event-kode">{kode}</span>
                      <span className="event-kosong-teks">
                        Pernah punya pemetaan, dan sekarang tidak ada satu pun yang berlaku. Ajukan
                        pemetaan baru untuk event ini.
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}

            {formBaru && bolehTulis ? (
              <FormUsulan
                mapping={data.data}
                tanpaPemetaan={data.tanpaPemetaan}
                akun={akun.data?.data ?? []}
                bolehBacaAkun={bolehBacaAkun}
                onSelesai={() => {
                  setFormBaru(false);
                  segarkan();
                }}
                onBatal={() => setFormBaru(false)}
              />
            ) : null}

            <Panel
              as="h2"
              title="Usulan menunggu keputusan"
              description="Setiap usulan ditampilkan sebagai perbandingan: yang berlaku saat usulan diajukan, di samping yang diusulkan."
              footer={
                <span className="panel-foot-note">
                  Sumber: GET /api/jurnal/mapping/usulan?status=DIAJUKAN. Usulan tidak terlihat oleh
                  mesin jurnal dan tidak mengubah apa pun sampai disetujui.
                </span>
              }
            >
              <Muat hasil={usulan} judul="daftar usulan" sumber="GET /api/jurnal/mapping/usulan">
                {() =>
                  menunggu.length === 0 ? (
                    <div className="antrean-kosong">
                      <span className="antrean-kosong-icon" aria-hidden="true">
                        <Icon name="checkCircle" size={20} />
                      </span>
                      <p className="antrean-kosong-title">Tidak ada usulan yang menunggu</p>
                      <p className="antrean-kosong-desc">
                        Semua pemetaan yang berlaku sudah pernah diputus oleh dua orang berbeda.
                      </p>
                    </div>
                  ) : (
                    <ul className="usul-list">
                      {menunggu.map((row) => (
                        <li key={row.id}>
                          <KartuUsulan
                            usulan={row}
                            namaAkun={namaAkun}
                            milikSendiri={row.diajukanBy === session.user.id}
                            bolehTulis={bolehTulis}
                            onSelesai={segarkan}
                          />
                        </li>
                      ))}
                    </ul>
                  )
                }
              </Muat>
            </Panel>

            <Panel
              as="h2"
              title="Pemetaan yang berlaku"
              description="Satu baris berlaku untuk setiap event. Baris lama tidak dihapus, hanya berhenti berlaku, supaya jurnal periode lama tetap bisa dijelaskan."
              footer={
                <span className="panel-foot-note">
                  Sumber: GET /api/jurnal/mapping. {formatCount(data.data.length)} pemetaan berlaku.
                </span>
              }
            >
              {data.data.length === 0 ? (
                <div className="antrean-kosong">
                  <span className="antrean-kosong-icon" aria-hidden="true">
                    <Icon name="list" size={20} />
                  </span>
                  <p className="antrean-kosong-title">Belum ada pemetaan yang berlaku</p>
                  <p className="antrean-kosong-desc">
                    Tidak ada satu pun event yang bisa memposting jurnal otomatis dalam keadaan ini.
                  </p>
                </div>
              ) : (
                <ul className="mapping-list">
                  {data.data.map((row) => (
                    <li className="mapping-item" key={row.id}>
                      <span className="mapping-head">
                        <span className="event-kode">{row.eventCode}</span>
                        <StatusBadge status={row.jenisJurnal} tone="neutral" />
                      </span>
                      <span className="mapping-kaki">
                        <span className="mapping-sisi">
                          <span className="mapping-label">Debit</span>
                          <span className="mapping-nilai">{kakiTeks(row, "debit")}</span>
                        </span>
                        <span className="mapping-sisi">
                          <span className="mapping-label">Kredit</span>
                          <span className="mapping-nilai">{kakiTeks(row, "kredit")}</span>
                        </span>
                      </span>
                      <span className="mapping-ket">{row.keterangan ?? "tanpa keterangan"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            {diputus.length > 0 ? (
              <Panel
                as="h2"
                title="Riwayat keputusan"
                description="Siapa mengajukan, siapa memutus, dan alasannya. Inilah yang membuat perubahan pemetaan bisa ditelusuri setahun kemudian."
                footer={
                  <span className="panel-foot-note">
                    Sumber: GET /api/jurnal/mapping/usulan. Dipotong server pada 200 baris terbaru.
                  </span>
                }
              >
                <ul className="riwayat-list">
                  {diputus.map((row) => (
                    <li className="riwayat-item" key={row.id}>
                      <span className="riwayat-head">
                        <span className="event-kode">{row.eventCode}</span>
                        <StatusBadge
                          status={row.status}
                          tone={TONE_USULAN[row.status] ?? "neutral"}
                          label={LABEL_USULAN[row.status] ?? row.status}
                        />
                      </span>
                      <span className="riwayat-teks">{row.alasan}</span>
                      <span className="riwayat-meta">
                        Diajukan {row.diajukanOleh ?? "pengguna tidak dikenal"}{" "}
                        {formatDate(row.diajukanAt)}
                        {row.diputusAt
                          ? ` . Diputus ${row.diputusOleh ?? "pengguna tidak dikenal"} ${formatDate(row.diputusAt)}`
                          : " . Ditarik pengusulnya"}
                        {row.catatanKeputusan ? ` . Catatan: ${row.catatanKeputusan}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}
          </>
        )}
      </Muat>

      <CatatanOtorisasi tambahan="Halaman ini terbuka dengan kewenangan konfigurasi.mapping. Kewenangan itu saja tidak cukup untuk mengubah pemetaan: pengusul dan pemutus harus dua orang yang berbeda, ditolak server sebelum menulis apa pun dan ditolak lagi oleh trigger basis data." />
    </HalamanModul>
  );
}

/** One leg of a mapping, as a sentence. Never a bare id. */
function kakiTeks(row: MappingTampil, sisi: "debit" | "kredit"): string {
  const dariPayload = sisi === "debit" ? row.debitDariPayload : row.kreditDariPayload;
  if (dariPayload) return "Ditentukan mesin jurnal saat posting";
  const kode = sisi === "debit" ? row.akunDebitKode : row.akunKreditKode;
  const nama = sisi === "debit" ? row.akunDebitNama : row.akunKreditNama;
  if (!kode) return "belum ditentukan";
  return nama ? `${kode} ${nama}` : kode;
}

/**
 * The same, for a proposal row.
 *
 * `UsulanTampil` carries the account CODE and no name, while `MappingTampil`
 * carries both. Rendered as the wire answers them, the diff would put
 * "1.1.01 Kas di Bank" beside a bare "1.1.02", and the one thing an approver is
 * being asked to compare would be the one thing shown two different ways. Seen
 * at 1440, not caught by a test. So the name is resolved from the chart of
 * accounts this screen already reads, by id, and a miss falls back to the code
 * alone rather than to a blank.
 */
function kakiUsulan(
  row: UsulanTampil,
  sisi: "debit" | "kredit",
  nama: ReadonlyMap<string, string>,
): string {
  const dariPayload = sisi === "debit" ? row.debitDariPayload : row.kreditDariPayload;
  if (dariPayload) return "Ditentukan mesin jurnal saat posting";
  const kode = sisi === "debit" ? row.akunDebitKode : row.akunKreditKode;
  if (!kode) return "belum ditentukan";
  const id = sisi === "debit" ? row.akunDebitId : row.akunKreditId;
  const label = id ? nama.get(id) : undefined;
  return label ? `${kode} ${label}` : kode;
}

function PenjelasanMakerChecker() {
  return (
    <Panel
      as="h2"
      title="Pemetaan event tidak diubah dengan satu klik, dan itu disengaja"
      description="Perubahan di halaman ini lebih dekat ke perubahan kode program daripada ke pengisian data."
      className="panel-panduan"
    >
      <ol className="langkah-list">
        <li>
          <strong>Diajukan.</strong> Satu orang mengajukan perubahan beserta alasannya. Pengajuan
          tidak mengubah apa pun: mesin jurnal hanya membaca baris pemetaan yang berlaku, dan usulan
          disimpan di tabel terpisah yang tidak dilihat mesin jurnal sama sekali.
        </li>
        <li>
          <strong>Diputus orang lain.</strong> Pemutus melihat pemetaan yang berlaku saat usulan
          diajukan, dibekukan pada usulan itu, di samping yang diusulkan. Yang disetujui adalah
          perubahan yang ditinjau, bukan keadaan terkini yang mungkin sudah bergeser. Menyetujui
          usulan sendiri ditolak server dan ditolak lagi oleh basis data.
        </li>
        <li>
          <strong>Berlaku.</strong> Persetujuan membuat baris baru berlaku dan baris lama berhenti
          berlaku, tanpa menghapusnya. Pertanyaan seperti akun apa yang dikredit event ini pada
          bulan Juli tetap punya jawaban berupa baris, bukan tebakan.
        </li>
        <li>
          Kumpulan kode event bukan data yang bisa ditambah dari sini. Kode event adalah kosakata
          mesin jurnal; yang boleh diubah adalah akun yang ditunjuknya.
        </li>
      </ol>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// One proposal, as a diff
// ---------------------------------------------------------------------------

function KartuUsulan({
  usulan,
  namaAkun,
  milikSendiri,
  bolehTulis,
  onSelesai,
}: {
  usulan: UsulanTampil;
  /** Account id to "kode nama", from the chart this screen already reads. */
  namaAkun: ReadonlyMap<string, string>;
  milikSendiri: boolean;
  bolehTulis: boolean;
  onSelesai: () => void;
}) {
  const [catatan, setCatatan] = useState("");
  const [konfirmasi, setKonfirmasi] = useState<"SETUJUI" | "TOLAK" | "BATAL" | null>(null);

  const setujui = useAction((isi: string | null) => setujuiUsulan(usulan.id, isi));
  const tolak = useAction((isi: string | null) => tolakUsulan(usulan.id, isi));
  const batal = useAction(() => batalUsulan(usulan.id));

  const sebelum = mappingSebelum(usulan);
  const galat = setujui.error ?? tolak.error ?? batal.error;
  const mengirim =
    setujui.status === "mengirim" || tolak.status === "mengirim" || batal.status === "mengirim";

  const baris = [
    {
      label: "Kaki debit",
      lama: sebelum ? kakiTeks(sebelum, "debit") : "belum ada pemetaan",
      baru: kakiUsulan(usulan, "debit", namaAkun),
    },
    {
      label: "Kaki kredit",
      lama: sebelum ? kakiTeks(sebelum, "kredit") : "belum ada pemetaan",
      baru: kakiUsulan(usulan, "kredit", namaAkun),
    },
    {
      label: "Jenis jurnal",
      lama: sebelum ? sebelum.jenisJurnal : "belum ada pemetaan",
      baru: usulan.jenisJurnal,
    },
  ];

  return (
    <div className="usul-kartu">
      <div className="usul-head">
        <span className="event-kode">{usulan.eventCode}</span>
        <StatusBadge
          status={usulan.status}
          tone={TONE_USULAN[usulan.status] ?? "neutral"}
          label={LABEL_USULAN[usulan.status] ?? usulan.status}
        />
      </div>

      <p className="usul-alasan">{usulan.alasan}</p>
      <p className="usul-meta">
        Diajukan {usulan.diajukanOleh ?? "pengguna tidak dikenal"} pada{" "}
        {formatDate(usulan.diajukanAt)}
      </p>

      <div className="usul-banding">
        <div className="usul-banding-kepala">
          <span className="usul-banding-label">Yang dibandingkan</span>
          <span className="usul-banding-sisi">Berlaku saat usulan diajukan</span>
          <span className="usul-banding-sisi">Diusulkan</span>
        </div>
        {baris.map((item) => {
          const berbeda = item.lama !== item.baru;
          return (
            <div className={berbeda ? "usul-banding-baris is-beda" : "usul-banding-baris"} key={item.label}>
              <span className="usul-banding-label">
                {item.label}
                {berbeda ? <span className="usul-tanda">berubah</span> : null}
              </span>
              <span className="usul-banding-sisi">{item.lama}</span>
              <span className="usul-banding-sisi">{item.baru}</span>
            </div>
          );
        })}
      </div>

      {sebelum === null ? (
        <p className="periksa-item">
          <Icon name="info" size={16} />
          <span>
            Event ini tidak punya pemetaan yang berlaku saat usulan diajukan, jadi kolom kiri kosong.
            Menyetujui usulan ini membuat event tersebut bisa memposting jurnal untuk pertama kalinya.
          </span>
        </p>
      ) : null}

      {!bolehTulis ? null : milikSendiri ? (
        <>
          <p className="periksa-item">
            <Icon name="lock" size={16} />
            <span>
              Anda yang mengajukan usulan ini, jadi Anda tidak boleh memutuskannya sendiri.
              Perubahan pemetaan event menentukan jurnal setiap transaksi event itu, sehingga wajib
              diputus oleh orang lain. Yang bisa Anda lakukan adalah menarik usulan Anda sendiri.
            </span>
          </p>
          <Penolakan pesan={galat} />
          <div className="form-actions-row">
            <Button
              variant="ghost"
              leading={<Icon name="close" size={16} />}
              loading={mengirim}
              onClick={() => setKonfirmasi("BATAL")}
            >
              Tarik usulan ini
            </Button>
          </div>
        </>
      ) : (
        <>
          <Field
            label="Catatan keputusan"
            htmlFor={`usul-catatan-${usulan.id}`}
            hint="Ikut tercatat pada audit trail dan pada riwayat usulan. Boleh kosong, tetapi catatan yang tertulis adalah yang dibaca orang berikutnya."
          >
            <Textarea
              id={`usul-catatan-${usulan.id}`}
              rows={2}
              maxLength={500}
              value={catatan}
              onChange={(event) => setCatatan(event.currentTarget.value)}
            />
          </Field>
          <Penolakan pesan={galat} />
          <div className="form-actions-row">
            <Button
              variant="ghost"
              leading={<Icon name="close" size={16} />}
              loading={mengirim}
              onClick={() => setKonfirmasi("TOLAK")}
            >
              Tolak usulan
            </Button>
            <Button
              variant="primary"
              leading={<Icon name="check" size={16} />}
              loading={mengirim}
              onClick={() => setKonfirmasi("SETUJUI")}
            >
              Setujui dan berlakukan
            </Button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={konfirmasi !== null}
        title={
          konfirmasi === "SETUJUI"
            ? `Setujui perubahan pemetaan ${usulan.eventCode}`
            : konfirmasi === "TOLAK"
              ? `Tolak usulan pemetaan ${usulan.eventCode}`
              : `Tarik usulan pemetaan ${usulan.eventCode}`
        }
        description={
          konfirmasi === "SETUJUI"
            ? "Mulai saat ini, setiap jurnal baru dari event ini memakai pemetaan yang diusulkan. Jurnal yang sudah diposting tidak berubah."
            : konfirmasi === "TOLAK"
              ? "Pemetaan yang berlaku tidak berubah. Penolakan beserta catatannya tercatat dan tetap terbaca."
              : "Usulan Anda ditarik dan tidak lagi menunggu keputusan siapa pun. Pemetaan yang berlaku tidak berubah."
        }
        confirmLabel={
          konfirmasi === "SETUJUI" ? "Setujui dan berlakukan" : konfirmasi === "TOLAK" ? "Tolak usulan" : "Tarik usulan"
        }
        tone={konfirmasi === "SETUJUI" ? "danger" : "primary"}
        confirmPhrase={konfirmasi === "SETUJUI" ? usulan.eventCode : undefined}
        confirmPhraseLabel="Ketik kode event untuk mengonfirmasi"
        loading={mengirim}
        error={galat}
        onCancel={() => setKonfirmasi(null)}
        onConfirm={() => {
          const pilihan = konfirmasi;
          setKonfirmasi(null);
          const isi = catatan.trim() === "" ? null : catatan.trim();
          const janji =
            pilihan === "SETUJUI"
              ? setujui.jalankan(isi)
              : pilihan === "TOLAK"
                ? tolak.jalankan(isi)
                : batal.jalankan(undefined);
          void janji.then((hasil) => {
            if (hasil) onSelesai();
          });
        }}
      >
        <DataList
          items={[
            { label: "Event", value: usulan.eventCode },
            { label: "Diajukan oleh", value: usulan.diajukanOleh ?? "pengguna tidak dikenal" },
            { label: "Alasan pengusul", value: usulan.alasan, wide: true },
            {
              label: "Kaki debit yang akan berlaku",
              value: kakiUsulan(usulan, "debit", namaAkun),
              wide: true,
            },
            {
              label: "Kaki kredit yang akan berlaku",
              value: kakiUsulan(usulan, "kredit", namaAkun),
              wide: true,
            },
          ]}
        />
      </ConfirmDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filing a proposal
// ---------------------------------------------------------------------------

const MIN_ALASAN = 10;

function FormUsulan({
  mapping,
  tanpaPemetaan,
  akun,
  bolehBacaAkun,
  onSelesai,
  onBatal,
}: {
  mapping: readonly MappingTampil[];
  tanpaPemetaan: readonly string[];
  akun: readonly AkunTampil[];
  bolehBacaAkun: boolean;
  onSelesai: () => void;
  onBatal: () => void;
}) {
  const daftarEvent = useMemo(() => {
    const kode = new Set<string>([...mapping.map((row) => row.eventCode), ...tanpaPemetaan]);
    return [...kode].sort();
  }, [mapping, tanpaPemetaan]);

  const [eventCode, setEventCode] = useState(daftarEvent[0] ?? "");
  const [debitDariPayload, setDebitDariPayload] = useState(false);
  const [kreditDariPayload, setKreditDariPayload] = useState(false);
  const [akunDebitId, setAkunDebitId] = useState("");
  const [akunKreditId, setAkunKreditId] = useState("");
  const [jenisJurnal, setJenisJurnal] = useState("OTOMATIS");
  const [alasan, setAlasan] = useState("");
  const [konfirmasi, setKonfirmasi] = useState(false);

  const kirim = useAction(ajukanMapping);

  const berlaku = mapping.find((row) => row.eventCode === eventCode) ?? null;
  const akunPostable = akun.filter((row) => row.isPostable && row.aktif);
  const opsiAkun = [
    { value: "", label: "Belum dipilih" },
    ...akunPostable.map((row) => ({ value: row.id, label: `${row.kode} ${row.nama}` })),
  ];

  const siap =
    eventCode !== "" &&
    alasan.trim().length >= MIN_ALASAN &&
    (debitDariPayload || akunDebitId !== "") &&
    (kreditDariPayload || akunKreditId !== "") &&
    !(akunDebitId !== "" && akunDebitId === akunKreditId);

  return (
    <Panel
      as="h2"
      title="Ajukan perubahan pemetaan"
      description="Mengajukan tidak mengubah apa pun. Usulan ini menunggu keputusan orang lain sebelum berlaku."
      aside={
        <Button variant="ghost" size="sm" onClick={onBatal}>
          Tutup
        </Button>
      }
      footer={
        <span className="panel-foot-note">
          Sumber: POST /api/jurnal/mapping/usulan. Server menolak usulan kedua untuk event yang
          usulannya masih menunggu keputusan.
        </span>
      }
    >
      {bolehBacaAkun ? null : (
        <p className="periksa-item">
          <Icon name="lock" size={16} />
          <span>
            Daftar akun dibaca lewat kewenangan konfigurasi.coa, yang tidak Anda pegang, jadi
            pemilih akun di bawah kosong. Kaki yang ditentukan mesin jurnal tetap bisa diusulkan.
            Mintalah pemegang konfigurasi.coa untuk mengajukan perubahan yang menunjuk akun tertentu.
          </span>
        </p>
      )}

      <FieldGrid>
        <Field
          label="Event"
          htmlFor="usul-event"
          required
          hint="Hanya event yang sudah dikenal mesin jurnal entitas ini. Kode event bukan data yang bisa ditambah dari halaman ini."
        >
          <Select
            id="usul-event"
            value={eventCode}
            onChange={(event) => setEventCode(event.currentTarget.value)}
            options={daftarEvent.map((kode) => ({ value: kode, label: kode }))}
          />
        </Field>
        <Field
          label="Jenis jurnal"
          htmlFor="usul-jenis"
          required
          hint="Jenis dokumen jurnal yang akan terbentuk dari event ini."
        >
          <Select
            id="usul-jenis"
            value={jenisJurnal}
            onChange={(event) => setJenisJurnal(event.currentTarget.value)}
            options={JENIS_JURNAL.map((kode) => ({ value: kode, label: kode }))}
          />
        </Field>
      </FieldGrid>

      {berlaku ? (
        <DataList
          columns={2}
          items={[
            { label: "Kaki debit yang berlaku sekarang", value: kakiTeks(berlaku, "debit") },
            { label: "Kaki kredit yang berlaku sekarang", value: kakiTeks(berlaku, "kredit") },
          ]}
        />
      ) : (
        <p className="periksa-item">
          <Icon name="info" size={16} />
          <span>
            Event ini tidak punya pemetaan yang berlaku sekarang, jadi setiap transaksinya gagal
            memposting jurnal sampai ada usulan yang disetujui.
          </span>
        </p>
      )}

      <div className="kaki-grid">
        <KakiUsulan
          sisi="Debit"
          idPrefix="usul-debit"
          dariPayload={debitDariPayload}
          onDariPayload={(nilai) => {
            setDebitDariPayload(nilai);
            if (nilai) setAkunDebitId("");
          }}
          akunId={akunDebitId}
          onAkun={setAkunDebitId}
          opsi={opsiAkun}
        />
        <KakiUsulan
          sisi="Kredit"
          idPrefix="usul-kredit"
          dariPayload={kreditDariPayload}
          onDariPayload={(nilai) => {
            setKreditDariPayload(nilai);
            if (nilai) setAkunKreditId("");
          }}
          akunId={akunKreditId}
          onAkun={setAkunKreditId}
          opsi={opsiAkun}
        />
      </div>

      {akunDebitId !== "" && akunDebitId === akunKreditId ? (
        <p className="periksa-item">
          <Icon name="alert" size={16} />
          <span>
            Kaki debit dan kaki kredit tidak boleh akun yang sama: jurnal seperti itu tidak
            memindahkan apa pun.
          </span>
        </p>
      ) : null}

      <Field
        label="Alasan perubahan"
        htmlFor="usul-alasan"
        required
        hint={`Minimal ${MIN_ALASAN} karakter. Baris pemetaan tidak menyimpan alasannya sendiri, dan inilah yang dibaca pemutus sebelum menyetujui.`}
      >
        <Textarea
          id="usul-alasan"
          rows={3}
          maxLength={1000}
          value={alasan}
          onChange={(event) => setAlasan(event.currentTarget.value)}
        />
      </Field>

      <Penolakan pesan={kirim.error} />
      <Berhasil pesan={kirim.hasil ? "Usulan diajukan dan sekarang menunggu keputusan orang lain." : null} />

      <div className="form-actions-row">
        <Button variant="ghost" onClick={onBatal}>
          Batal
        </Button>
        <Button variant="primary" disabled={!siap} onClick={() => setKonfirmasi(true)}>
          Ajukan usulan
        </Button>
      </div>

      <ConfirmDialog
        open={konfirmasi}
        title={`Ajukan perubahan pemetaan ${eventCode}`}
        description="Usulan ini tidak mengubah apa pun sampai disetujui orang lain. Anda tidak akan bisa menyetujuinya sendiri."
        confirmLabel="Ajukan usulan"
        loading={kirim.status === "mengirim"}
        error={kirim.error}
        onCancel={() => setKonfirmasi(false)}
        onConfirm={() => {
          setKonfirmasi(false);
          void kirim
            .jalankan({
              eventCode,
              akunDebitId: debitDariPayload ? null : akunDebitId,
              akunKreditId: kreditDariPayload ? null : akunKreditId,
              debitDariPayload,
              kreditDariPayload,
              jenisJurnal,
              keterangan: null,
              alasan: alasan.trim(),
            })
            .then((hasil) => {
              if (hasil) onSelesai();
            });
        }}
      >
        <DataList
          items={[
            { label: "Event", value: eventCode },
            {
              label: "Kaki debit yang diusulkan",
              value: debitDariPayload
                ? "Ditentukan mesin jurnal saat posting"
                : (opsiAkun.find((item) => item.value === akunDebitId)?.label ?? "belum dipilih"),
              wide: true,
            },
            {
              label: "Kaki kredit yang diusulkan",
              value: kreditDariPayload
                ? "Ditentukan mesin jurnal saat posting"
                : (opsiAkun.find((item) => item.value === akunKreditId)?.label ?? "belum dipilih"),
              wide: true,
            },
            { label: "Alasan", value: alasan.trim(), wide: true },
          ]}
        />
      </ConfirmDialog>
    </Panel>
  );
}

/** One leg of a proposed mapping: an account, or the engine's own choice. */
function KakiUsulan({
  sisi,
  idPrefix,
  dariPayload,
  onDariPayload,
  akunId,
  onAkun,
  opsi,
}: {
  sisi: string;
  idPrefix: string;
  dariPayload: boolean;
  onDariPayload: (nilai: boolean) => void;
  akunId: string;
  onAkun: (id: string) => void;
  opsi: readonly { value: string; label: string }[];
}) {
  return (
    <div className="kaki-kartu">
      <p className="kaki-judul">Kaki {sisi.toLowerCase()}</p>
      <div className="sifat-item">
        <label className="sifat-kotak" htmlFor={`${idPrefix}-payload`}>
          <input
            id={`${idPrefix}-payload`}
            type="checkbox"
            checked={dariPayload}
            onChange={(event) => onDariPayload(event.currentTarget.checked)}
          />
          <span className="sifat-teks">
            <span className="sifat-label">Ditentukan mesin jurnal</span>
            <span className="sifat-arti">
              Akunnya dipilih saat posting, misalnya akun kas yang dipakai transaksi itu.
            </span>
          </span>
        </label>
      </div>
      <Field
        label={`Akun ${sisi.toLowerCase()}`}
        htmlFor={`${idPrefix}-akun`}
        hint={
          dariPayload
            ? "Dikosongkan karena mesin jurnal yang memilih akunnya. Server menolak usulan yang mengisi keduanya."
            : "Hanya akun aktif yang bisa dijurnal. Akun induk tidak boleh menjadi kaki jurnal."
        }
      >
        <Select
          id={`${idPrefix}-akun`}
          value={dariPayload ? "" : akunId}
          disabled={dariPayload}
          onChange={(event) => onAkun(event.currentTarget.value)}
          options={opsi}
        />
      </Field>
    </div>
  );
}

// Reschedule Angsuran, spec 7.3 and spec 9.1: "halaman reschedule dengan
// preview jadwal baru SEBELUM submit".
//
// So the preview is a gate, not a convenience: the submit button stays closed
// until the engine has returned a proposed schedule for exactly the parameters
// currently in the form, and any edit after that closes it again. Nobody
// records a reschedule against a schedule they have not seen.
//
// The preview is the engine's arithmetic, requested without writing a version.
// Nothing on this page computes a schedule.
import { useState } from "react";
import {
  Bento,
  BentoItem,
  Button,
  ConfirmDialog,
  DataList,
  ErrorState,
  Field,
  Icon,
  Panel,
  Select,
  Stat,
  Textarea,
  TextInput,
  formatCount,
  formatMoney,
  formatRate,
  parseRate,
} from "@krakatausteel/ui";
import {
  ajukanReschedule,
  pratinjauReschedule,
  type BarisAkad,
  type JenisReschedule,
} from "../../api/pumk";
import { useAction } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useRouter } from "../../router";
import { AkadPicker } from "./AkadPicker";
import { JadwalTabel, RingkasanJadwalPanel } from "./JadwalTabel";
import {
  Bagian,
  BarisAksi,
  CatatanOtorisasi,
  FieldGrid,
  HalamanModul,
  hariIni,
  usePilihan,
} from "../shared/parts";

const JENIS: Array<{ value: JenisReschedule; label: string; catatan: string }> = [
  {
    value: "PERPANJANG_TENOR",
    label: "Perpanjang tenor",
    catatan: "Sisa pokok dibagi ke jumlah bulan yang lebih panjang.",
  },
  {
    value: "TURUNKAN_ANGSURAN",
    label: "Turunkan angsuran",
    catatan: "Nilai angsuran per bulan diturunkan, tenor menyesuaikan.",
  },
  {
    value: "GRACE_PERIOD",
    label: "Beri grace period",
    catatan: "Penundaan angsuran pokok selama beberapa bulan.",
  },
  {
    value: "RESTRUKTUR_POKOK",
    label: "Restruktur pokok",
    catatan:
      "Perubahan nilai pokok. Pemetaan jurnal untuk peristiwa ini belum diputuskan, sehingga server akan menolak permintaannya.",
  },
];

export function Reschedule({ route }: { route: PageRoute }) {
  const { navigate } = useRouter();
  const [akadId, setAkadId] = usePilihan("akad");
  const [akad, setAkad] = useState<BarisAkad | null>(null);

  const [jenis, setJenis] = useState<JenisReschedule>("PERPANJANG_TENOR");
  const [tenorBaru, setTenorBaru] = useState("");
  const [graceBaru, setGraceBaru] = useState("");
  const [rateBaru, setRateBaru] = useState("");
  const [alasan, setAlasan] = useState("");
  const [catatan, setCatatan] = useState("");
  const [konfirmasi, setKonfirmasi] = useState(false);
  // The parameters the current preview belongs to. Any edit invalidates it.
  const [pratinjauUntuk, setPratinjauUntuk] = useState<string | null>(null);

  const pratinjau = useAction(pratinjauReschedule);
  const ajukan = useAction(ajukanReschedule);

  const rateTerbaca = rateBaru.trim() === "" || parseRate(rateBaru) !== null;
  const kunci = JSON.stringify({ jenis, tenorBaru, graceBaru, rateBaru });
  const pratinjauSegar = pratinjauUntuk === kunci && pratinjau.hasil !== null;
  const bolehAjukan = pratinjauSegar && alasan.trim() !== "" && rateTerbaca;
  const jenisTerpilih = JENIS.find((item) => item.value === jenis) ?? JENIS[0]!;

  function ubah(setter: (value: string) => void) {
    return (value: string) => {
      setter(value);
      setPratinjauUntuk(null);
    };
  }

  async function lihatPratinjau() {
    if (!akadId) return;
    const hasil = await pratinjau.jalankan({
      akadId,
      jenis,
      tenorBaru: tenorBaru === "" ? null : Number(tenorBaru),
      graceBaru: graceBaru === "" ? null : Number(graceBaru),
      jasaRateBaru: parseRate(rateBaru),
    });
    setPratinjauUntuk(hasil ? kunci : null);
  }

  async function kirim() {
    if (!akadId || !bolehAjukan) return;
    const hasil = await ajukan.jalankan({
      akadId,
      tanggalPengajuan: hariIni(),
      alasan: alasan.trim(),
      jenis,
      tenorBaru: tenorBaru === "" ? null : Number(tenorBaru),
      graceBaru: graceBaru === "" ? null : Number(graceBaru),
      jasaRateBaru: parseRate(rateBaru),
      catatan: catatan.trim() || null,
    });
    if (hasil) {
      setKonfirmasi(false);
      navigate(`/pumk/kartu-piutang/${akadId}`);
    }
  }

  if (akadId === null) {
    return (
      <HalamanModul route={route}>
        <AkadPicker
          title="Pilih akad yang akan dijadwalkan ulang"
          description="Reschedule hanya berlaku untuk akad yang masih berjalan."
          status="AKTIF"
          emptyTitle="Belum ada akad aktif pada cabang ini"
          emptyDescription="Akad menjadi aktif setelah pencairan dicatat."
          onPilih={(baris) => {
            setAkad(baris);
            setAkadId(baris.id);
          }}
        />
        <CatatanOtorisasi />
      </HalamanModul>
    );
  }

  const hasil = pratinjauSegar ? pratinjau.hasil : null;

  return (
    <HalamanModul
      route={route}
      title={akad ? `Reschedule akad ${akad.noAkad}` : route.title}
      sub={akad ? `${akad.mitraNama} . ${akad.cabangNama}` : route.summary}
      back={{ to: "/pumk/reschedule", label: "Pilih akad lain" }}
    >
      <form
        className="form-main"
        onSubmit={(event) => {
          event.preventDefault();
          void lihatPratinjau();
        }}
      >
        <Bagian
          title="Usulan penjadwalan ulang"
          description="Isi usulan, lihat pratinjau jadwal barunya, baru ajukan. Pengajuan tidak terbuka sebelum pratinjau untuk parameter yang sama ditampilkan."
          aside={
            <span className="tabs-note">
              {pratinjauSegar ? "Pratinjau sesuai parameter saat ini" : "Pratinjau belum dibuat"}
            </span>
          }
        >
          <FieldGrid>
            <Field label="Jenis reschedule" htmlFor="jenis-reschedule" required hint={jenisTerpilih.catatan}>
              <Select
                id="jenis-reschedule"
                value={jenis}
                onChange={(event) => {
                  setJenis(event.currentTarget.value as JenisReschedule);
                  setPratinjauUntuk(null);
                }}
                options={JENIS.map((item) => ({ value: item.value, label: item.label }))}
              />
            </Field>
            <Field label="Tenor baru (bulan)" htmlFor="tenor-baru" hint="Kosongkan bila tenor tidak berubah.">
              <TextInput
                id="tenor-baru"
                type="number"
                inputMode="numeric"
                min={1}
                value={tenorBaru}
                onChange={(event) => ubah(setTenorBaru)(event.currentTarget.value)}
              />
            </Field>
            <Field label="Grace period baru (bulan)" htmlFor="grace-baru" hint="Kosongkan bila tidak ada penundaan.">
              <TextInput
                id="grace-baru"
                type="number"
                inputMode="numeric"
                min={0}
                value={graceBaru}
                onChange={(event) => ubah(setGraceBaru)(event.currentTarget.value)}
              />
            </Field>
            <Field
              label="Rate Jasa Administrasi baru (persen)"
              htmlFor="rate-baru"
              hint="Kosongkan bila rate tidak berubah."
              error={rateTerbaca ? undefined : "Rate tidak terbaca. Contoh penulisan: 3 atau 3,5."}
            >
              <TextInput
                id="rate-baru"
                inputMode="decimal"
                value={rateBaru}
                invalid={!rateTerbaca}
                onChange={(event) => ubah(setRateBaru)(event.currentTarget.value)}
              />
            </Field>
          </FieldGrid>
          <Field label="Alasan reschedule" htmlFor="alasan-reschedule" required hint="Wajib diisi dan tersimpan pada audit trail.">
            <Textarea
              id="alasan-reschedule"
              rows={2}
              value={alasan}
              onChange={(event) => setAlasan(event.currentTarget.value)}
            />
          </Field>
          <Field label="Catatan tambahan" htmlFor="catatan-reschedule">
            <Textarea
              id="catatan-reschedule"
              rows={2}
              value={catatan}
              onChange={(event) => setCatatan(event.currentTarget.value)}
            />
          </Field>
        </Bagian>

        <BarisAksi
          error={ajukan.error}
          secondary={
            <Button
              type="submit"
              variant="secondary"
              loading={pratinjau.status === "mengirim"}
              loadingLabel="Menghitung"
            >
              Lihat pratinjau jadwal baru
            </Button>
          }
          primary={
            <Button
              variant="primary"
              disabled={!bolehAjukan}
              loading={ajukan.status === "mengirim"}
              loadingLabel="Mengajukan"
              onClick={() => setKonfirmasi(true)}
            >
              Ajukan reschedule
            </Button>
          }
        />
      </form>

      {pratinjau.status === "gagal" ? (
        <ErrorState
          title="Pratinjau jadwal tidak dapat dihitung"
          description="Tanpa pratinjau, pengajuan reschedule tetap tertutup. Halaman ini tidak menghitung jadwal sendiri."
          detail={pratinjau.error}
          sumber="POST /api/pumk/reschedule/pratinjau"
          onRetry={() => void lihatPratinjau()}
        />
      ) : null}

      {hasil ? (
        <>
          <Bento columns={4}>
            <BentoItem span="sm">
              <Panel as="h2" title="Outstanding saat ini" className="panel-kpi">
                <Stat
                  label="Sisa pokok sebelum reschedule"
                  value={formatMoney(hasil.outstandingSaatIni)}
                  hint="Menjadi pokok jadwal versi baru."
                />
              </Panel>
            </BentoItem>
            <BentoItem span="sm">
              <Panel as="h2" title="Pokok terbayar historis" className="panel-kpi">
                <Stat
                  label="Sudah diterima sebelum reschedule"
                  value={formatMoney(hasil.pokokTerbayarHistoris)}
                  hint="Bersama outstanding, sama dengan pokok pinjaman semula."
                />
              </Panel>
            </BentoItem>
            <BentoItem span="sm">
              <Panel as="h2" title="Versi jadwal berjalan" className="panel-kpi">
                <Stat
                  label="Yang akan digantikan"
                  value={formatCount(hasil.jadwalBerjalan.versi)}
                  hint={`${formatCount(hasil.jadwalBerjalan.baris.length)} baris angsuran`}
                />
              </Panel>
            </BentoItem>
            <BentoItem span="sm">
              <Panel as="h2" title="Angsuran per bulan usulan" className="panel-kpi">
                <Stat
                  label="Setelah reschedule"
                  value={formatMoney(hasil.jadwalUsulan.ringkasan.angsuranPerBulan)}
                  hint={`Semula ${formatMoney(hasil.jadwalBerjalan.ringkasan.angsuranPerBulan)}`}
                />
              </Panel>
            </BentoItem>
          </Bento>

          <div className="banding">
            <Panel
              as="h2"
              title={`Jadwal berjalan, versi ${hasil.jadwalBerjalan.versi}`}
              description="Jadwal yang dipakai menagih hari ini. Ditandai SUPERSEDED bila reschedule disetujui."
              footer={<span>Riwayat versi lama tetap utuh dan tidak dapat diubah.</span>}
            >
              <RingkasanJadwalPanel ringkasan={hasil.jadwalBerjalan.ringkasan} />
              <JadwalTabel baris={hasil.jadwalBerjalan.baris} caption="Jadwal berjalan" />
            </Panel>

            <Panel
              as="h2"
              title="Jadwal usulan"
              description="Belum disimpan. Jadwal ini hanya terbentuk bila pengajuan diajukan dan kemudian disetujui."
              footer={
                <span>
                  Total pokok jadwal usulan wajib sama dengan sisa pokok akad,{" "}
                  {formatMoney(hasil.outstandingSaatIni)}.
                </span>
              }
            >
              <RingkasanJadwalPanel ringkasan={hasil.jadwalUsulan.ringkasan} />
              <JadwalTabel baris={hasil.jadwalUsulan.baris} caption="Jadwal usulan" />
            </Panel>
          </div>

          <Panel
            as="h2"
            title="Parameter usulan"
            footer={<span>Nilai ini dipakai engine untuk menyusun jadwal versi baru.</span>}
          >
            <DataList
              columns={2}
              items={[
                { label: "Jenis", value: jenisTerpilih.label },
                {
                  label: "Tenor baru",
                  value:
                    tenorBaru === ""
                      ? "Tidak berubah"
                      : `${formatCount(Number(tenorBaru))} bulan`,
                  numeric: true,
                },
                {
                  label: "Grace period baru",
                  value:
                    graceBaru === ""
                      ? "Tidak berubah"
                      : `${formatCount(Number(graceBaru))} bulan`,
                  numeric: true,
                },
                {
                  label: "Rate baru",
                  value:
                    rateBaru.trim() === ""
                      ? "Tidak berubah"
                      : `${formatRate(parseRate(rateBaru))} persen per tahun`,
                  numeric: true,
                },
              ]}
            />
          </Panel>
        </>
      ) : (
        <Panel
          as="h2"
          title="Pratinjau belum dibuat"
          footer={<span>Pengajuan reschedule tetap tertutup sampai pratinjau ditampilkan.</span>}
        >
          <p className="penjelasan">
            <Icon name="info" size={16} /> Isi usulan di atas, lalu tekan Lihat pratinjau jadwal
            baru. Jadwal usulan dihitung oleh engine angsuran dan tidak disimpan sampai pengajuan
            benar benar diajukan dan disetujui.
          </p>
        </Panel>
      )}

      <ConfirmDialog
        open={konfirmasi}
        title="Konfirmasi pengajuan reschedule"
        description="Pengajuan tersimpan berstatus Draft. Jadwal versi baru baru terbentuk setelah pengajuan ini disetujui."
        confirmLabel="Ajukan reschedule"
        loading={ajukan.status === "mengirim"}
        error={ajukan.error}
        onCancel={() => setKonfirmasi(false)}
        onConfirm={kirim}
      >
        <DataList
          items={[
            { label: "Akad", value: akad?.noAkad ?? akadId },
            { label: "Jenis", value: jenisTerpilih.label },
            {
              label: "Sisa pokok",
              value: hasil ? formatMoney(hasil.outstandingSaatIni) : "Belum diketahui",
              numeric: true,
            },
            { label: "Alasan", value: alasan.trim() || "Belum diisi", wide: true },
          ]}
        />
      </ConfirmDialog>

      <CatatanOtorisasi tambahan="Persetujuan reschedule dilakukan oleh pemegang hak persetujuan, bukan oleh pengaju." />
    </HalamanModul>
  );
}

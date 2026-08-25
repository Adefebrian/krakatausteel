// Pengakhiran Akad dan Hapus Buku, spec 9.1.
//
// A WRITE-OFF IS NOT ONE FIGURE, and this page refuses to show it as one. The
// ledger consumes the allowance already carried for the receivable first and
// charges only the remainder as a shortfall, so the preview prints three
// numbers side by side: the outstanding principal, the part the allowance
// absorbs, and the shortfall. A screen that showed only the outstanding would
// let an operator believe the allowance always covers it, which is a
// misstatement of what actually hits the accounts.
//
// Hapus buku does NOT extinguish the debt. The receivable leaves the active
// book and the right to collect survives (SK-277/MBU/10/2023), which is why the
// confirmation says so and why the operator has to type the phrase.
//
// PENGHAPUSAN_BERSYARAT has no sanctioned event mapping in spec 6.4, so the
// server refuses it. The page says that before the button rather than after.
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
  StatusBadge,
  Textarea,
  TextInput,
  formatDate,
  formatMoney,
} from "@krakatausteel/ui";
import {
  catatPengakhiran,
  pratinjauPengakhiran,
  type BarisAkad,
  type Pengakhiran as PengakhiranHasil,
} from "../../api/pumk";
import { useAction } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useRouter } from "../../router";
import { AkadPicker } from "./AkadPicker";
import {
  Bagian,
  BarisAksi,
  CatatanOtorisasi,
  CatatanPencatatan,
  FieldGrid,
  HalamanModul,
  hariIni,
  usePilihan,
} from "../shared/parts";

type Jenis = PengakhiranHasil["jenis"];

const JENIS: Array<{ value: Jenis; label: string; catatan: string; frasa: string | null }> = [
  {
    value: "LUNAS_DIPERCEPAT",
    label: "Pengakhiran akad lunas",
    catatan:
      "Menutup akad yang kewajibannya sudah selesai. Tidak ada dana yang berpindah, sehingga tidak ada jurnal baru.",
    frasa: null,
  },
  {
    value: "HAPUS_BUKU",
    label: "Hapus buku piutang macet",
    catatan:
      "Mengeluarkan piutang dari pembukuan aktif. Hak tagih tetap ada dan piutang tetap tercatat ekstrakomtabel.",
    frasa: "HAPUS BUKU",
  },
  {
    value: "PENGHAPUSAN_BERSYARAT",
    label: "Penghapusan bersyarat (penghapustagihan)",
    catatan:
      "Peristiwa hukum yang berbeda dari hapus buku dan belum memiliki pemetaan jurnal yang disahkan. Server akan menolak permintaan ini.",
    frasa: "HAPUS TAGIH",
  },
];

export function Pengakhiran({ route }: { route: PageRoute }) {
  const { navigate } = useRouter();
  const [akadId, setAkadId] = usePilihan("akad");
  const [akad, setAkad] = useState<BarisAkad | null>(null);

  const [jenis, setJenis] = useState<Jenis>("LUNAS_DIPERCEPAT");
  const [tanggal, setTanggal] = useState(hariIni());
  const [dasar, setDasar] = useState("");
  const [noSk, setNoSk] = useState("");
  const [konfirmasi, setKonfirmasi] = useState(false);
  const [pratinjauUntuk, setPratinjauUntuk] = useState<string | null>(null);

  const pratinjau = useAction(pratinjauPengakhiran);
  const simpan = useAction(catatPengakhiran);

  const kunci = JSON.stringify({ jenis, tanggal });
  const segar = pratinjauUntuk === kunci && pratinjau.hasil !== null;
  const hasil = segar ? pratinjau.hasil : null;
  const pilihan = JENIS.find((item) => item.value === jenis) ?? JENIS[0]!;
  const ditolak = hasil?.penolakan ?? null;
  const bolehSimpan = segar && ditolak === null && dasar.trim() !== "";

  async function lihatPratinjau() {
    if (!akadId) return;
    const jawaban = await pratinjau.jalankan({ akadId, jenis, tanggal });
    setPratinjauUntuk(jawaban ? kunci : null);
  }

  async function kirim() {
    if (!akadId || !bolehSimpan) return;
    const jawaban = await simpan.jalankan({
      akadId,
      jenis,
      tanggal,
      dasarKeputusan: dasar.trim(),
      noSk: noSk.trim() || null,
    });
    if (jawaban) {
      setKonfirmasi(false);
      navigate(`/pumk/kartu-piutang/${akadId}`);
    }
  }

  if (akadId === null) {
    return (
      <HalamanModul route={route}>
        <AkadPicker
          title="Pilih akad yang akan diakhiri"
          description="Pengakhiran berlaku untuk akad yang sudah lunas maupun untuk piutang macet yang akan dihapusbukukan."
          emptyTitle="Belum ada akad pada cabang ini"
          emptyDescription="Akad terbentuk setelah proposal disetujui dan realisasi akad dicatat."
          onPilih={(baris) => {
            setAkad(baris);
            setAkadId(baris.id);
          }}
        />
        <CatatanPencatatan />
        <CatatanOtorisasi />
      </HalamanModul>
    );
  }

  return (
    <HalamanModul
      route={route}
      title={akad ? `Pengakhiran akad ${akad.noAkad}` : route.title}
      sub={akad ? `${akad.mitraNama} . ${akad.cabangNama}` : route.summary}
      back={{ to: "/pumk/pengakhiran", label: "Pilih akad lain" }}
    >
      <form
        className="form-main"
        onSubmit={(event) => {
          event.preventDefault();
          void lihatPratinjau();
        }}
      >
        <Bagian
          title="Jenis pengakhiran"
          description="Pilih jenis, lihat pratinjau dampaknya terhadap pembukuan, baru simpan. Penyimpanan tetap tertutup sebelum pratinjau untuk pilihan yang sama ditampilkan."
          aside={
            <span className="tabs-note">
              {segar ? "Pratinjau sesuai pilihan saat ini" : "Pratinjau belum dibuat"}
            </span>
          }
        >
          <FieldGrid>
            <Field label="Jenis" htmlFor="jenis-pengakhiran" required hint={pilihan.catatan}>
              <Select
                id="jenis-pengakhiran"
                value={jenis}
                onChange={(event) => {
                  setJenis(event.currentTarget.value as Jenis);
                  setPratinjauUntuk(null);
                }}
                options={JENIS.map((item) => ({ value: item.value, label: item.label }))}
              />
            </Field>
            <Field label="Tanggal pengakhiran" htmlFor="tanggal-pengakhiran" required>
              <TextInput
                id="tanggal-pengakhiran"
                type="date"
                value={tanggal}
                onChange={(event) => {
                  setTanggal(event.currentTarget.value);
                  setPratinjauUntuk(null);
                }}
              />
            </Field>
          </FieldGrid>
          <Field label="Nomor SK" htmlFor="no-sk" hint="Nomor surat keputusan yang mendasari, bila ada.">
            <TextInput id="no-sk" value={noSk} onChange={(event) => setNoSk(event.currentTarget.value)} />
          </Field>
          <Field label="Dasar keputusan" htmlFor="dasar-keputusan" required hint="Wajib diisi dan tersimpan pada audit trail.">
            <Textarea
              id="dasar-keputusan"
              rows={3}
              value={dasar}
              onChange={(event) => setDasar(event.currentTarget.value)}
            />
          </Field>
        </Bagian>

        <BarisAksi
          error={simpan.error}
          secondary={
            <Button
              type="submit"
              variant="secondary"
              loading={pratinjau.status === "mengirim"}
              loadingLabel="Menghitung"
            >
              Lihat dampak pembukuan
            </Button>
          }
          primary={
            <Button
              variant="danger"
              disabled={!bolehSimpan}
              loading={simpan.status === "mengirim"}
              loadingLabel="Menyimpan"
              onClick={() => setKonfirmasi(true)}
            >
              {pilihan.label}
            </Button>
          }
        />
      </form>

      {pratinjau.status === "gagal" ? (
        <ErrorState
          title="Dampak pembukuan tidak dapat dihitung"
          description="Tanpa pratinjau, pengakhiran tetap tertutup. Halaman ini tidak menghitung penyisihan sendiri."
          detail={pratinjau.error}
          sumber="POST /api/pumk/pengakhiran/pratinjau"
          onRetry={() => void lihatPratinjau()}
        />
      ) : null}

      {ditolak ? (
        <div className="peringatan" role="alert">
          <Icon name="lock" size={18} />
          <div>
            <p className="peringatan-judul">Peristiwa ini belum memiliki pemetaan jurnal</p>
            <p className="peringatan-teks">{ditolak}</p>
          </div>
        </div>
      ) : null}

      {hasil ? (
        <>
          <Bento columns={4}>
            <BentoItem span="sm">
              <Panel as="h2" title="Outstanding pokok" className="panel-kpi">
                <Stat
                  label="Sisa pokok saat pengakhiran"
                  value={formatMoney(hasil.outstandingPokok)}
                  hint="Nilai yang keluar dari pembukuan aktif."
                />
              </Panel>
            </BentoItem>
            <BentoItem span="sm">
              <Panel as="h2" title="Penyisihan tersedia" className="panel-kpi">
                <Stat
                  label="Cadangan yang sudah dibentuk"
                  value={formatMoney(hasil.penyisihanTersedia)}
                  hint="Hasil closing kolektibilitas periode sebelumnya."
                />
              </Panel>
            </BentoItem>
            <BentoItem span="sm">
              <Panel as="h2" title="Penyisihan dipakai" className="panel-kpi">
                <Stat
                  label="Diserap lebih dahulu"
                  value={formatMoney(hasil.penyisihanDipakai)}
                  hint="Bagian pokok yang ditutup oleh cadangan."
                />
              </Panel>
            </BentoItem>
            <BentoItem span="sm">
              <Panel as="h2" title="Kekurangan penyisihan" className="panel-kpi">
                <Stat
                  label="Sisa yang dibebankan"
                  value={formatMoney(hasil.kekuranganPenyisihan)}
                  hint={
                    hasil.kekuranganPenyisihan === "0.00"
                      ? "Cadangan menutup seluruh pokok."
                      : "Dibukukan melalui event kekurangan penyisihan, terpisah dari hapus buku."
                  }
                  aside={
                    <StatusBadge
                      status={hasil.kekuranganPenyisihan === "0.00" ? "TERTUTUP" : "ADA_KEKURANGAN"}
                      tone={hasil.kekuranganPenyisihan === "0.00" ? "success" : "warning"}
                      label={
                        hasil.kekuranganPenyisihan === "0.00" ? "Tertutup cadangan" : "Ada kekurangan"
                      }
                    />
                  }
                />
              </Panel>
            </BentoItem>
          </Bento>

          <Panel
            as="h2"
            title="Jurnal yang akan terbentuk"
            description="Urutan event sesuai pemetaan pada spesifikasi akuntansi. Penyisihan yang tersedia diserap lebih dahulu, sisanya baru menjadi kekurangan."
            footer={
              <span>
                Jurnal dibentuk oleh engine jurnal melalui event mapping, bukan diketik pada halaman
                ini.
              </span>
            }
          >
            {hasil.eventJurnal.length === 0 ? (
              <p className="penjelasan">
                Tidak ada jurnal yang terbentuk. Pengakhiran lunas hanya menutup akad, karena dana
                sudah berpindah melalui setoran angsuran.
              </p>
            ) : (
              <ol className="langkah-list">
                {hasil.eventJurnal.map((event) => (
                  <li key={event}>{event}</li>
                ))}
              </ol>
            )}
            <DataList
              columns={2}
              items={[
                { label: "Outstanding pokok", value: formatMoney(hasil.outstandingPokok), numeric: true },
                { label: "Outstanding Jasa Administrasi", value: formatMoney(hasil.outstandingJasa), numeric: true },
                { label: "Penyisihan dipakai", value: formatMoney(hasil.penyisihanDipakai), numeric: true },
                {
                  label: "Kekurangan penyisihan",
                  value: formatMoney(hasil.kekuranganPenyisihan),
                  numeric: true,
                },
              ]}
            />
          </Panel>
        </>
      ) : (
        <Panel
          as="h2"
          title="Dampak pembukuan belum dihitung"
          footer={<span>Penyimpanan tetap tertutup sampai dampaknya ditampilkan.</span>}
        >
          <p className="penjelasan">
            Pilih jenis pengakhiran dan tanggalnya, lalu tekan Lihat dampak pembukuan. Halaman akan
            menampilkan berapa bagian pokok yang diserap penyisihan dan berapa yang menjadi
            kekurangan, terpisah, bukan sebagai satu angka.
          </p>
        </Panel>
      )}

      <ConfirmDialog
        open={konfirmasi}
        title={`Konfirmasi ${pilihan.label.toLowerCase()}`}
        description={
          jenis === "HAPUS_BUKU"
            ? "Hapus buku mengeluarkan piutang dari pembukuan aktif. Hak tagih tetap ada dan piutang tetap tercatat ekstrakomtabel. Tindakan ini tidak dapat dibatalkan dari halaman mana pun."
            : "Tindakan ini dicatat beserta nama Anda dan waktunya, dan tidak dapat dibatalkan dari halaman ini."
        }
        confirmLabel={pilihan.label}
        tone="danger"
        confirmPhrase={pilihan.frasa ?? undefined}
        loading={simpan.status === "mengirim"}
        error={simpan.error}
        onCancel={() => setKonfirmasi(false)}
        onConfirm={kirim}
      >
        <DataList
          items={[
            { label: "Akad", value: akad?.noAkad ?? akadId },
            { label: "Mitra Binaan", value: akad?.mitraNama ?? "Tidak diketahui" },
            { label: "Tanggal", value: formatDate(tanggal) },
            {
              label: "Outstanding pokok",
              value: hasil ? formatMoney(hasil.outstandingPokok) : "Belum dihitung",
              numeric: true,
            },
            {
              label: "Penyisihan dipakai",
              value: hasil ? formatMoney(hasil.penyisihanDipakai) : "Belum dihitung",
              numeric: true,
            },
            {
              label: "Kekurangan penyisihan",
              value: hasil ? formatMoney(hasil.kekuranganPenyisihan) : "Belum dihitung",
              numeric: true,
            },
            { label: "Nomor SK", value: noSk.trim() || "Tidak diisi" },
            { label: "Dasar keputusan", value: dasar.trim() || "Belum diisi", wide: true },
          ]}
        />
      </ConfirmDialog>

      <Panel
        as="h2"
        title="Yang tetap berlaku setelah hapus buku"
        footer={<span>Dasar hukum: SK-277/MBU/10/2023 mengenai penghapusbukuan piutang.</span>}
      >
        <ol className="langkah-list">
          <li>Piutang keluar dari pembukuan aktif, bukan hilang dari sistem.</li>
          <li>Hak tagih kepada Mitra Binaan tetap ada.</li>
          <li>Piutang tetap tercatat ekstrakomtabel dan tetap muncul pada laporan terkait.</li>
          <li>
            Setoran yang masuk setelah hapus buku dicatat sebagai penerimaan kembali, bukan sebagai
            angsuran biasa.
          </li>
        </ol>
      </Panel>

      <CatatanPencatatan />
      <CatatanOtorisasi tambahan="Satu akad hanya dapat memiliki satu pengakhiran, dan hapus buku memerlukan hak akses tersendiri." />
    </HalamanModul>
  );
}

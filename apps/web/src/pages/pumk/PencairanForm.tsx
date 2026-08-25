// Pencairan Dana, spec 9.1.
//
// This page RECORDS a disbursement that has already happened at the bank. It
// does not move money and it never says it does: what it produces is the
// PENCAIRAN_PUMK journal and the akad becoming active, in one transaction, and
// the confirmation dialog says exactly that before the operator commits.
import { useEffect, useState } from "react";
import {
  Button,
  ConfirmDialog,
  DataList,
  Field,
  MoneyInput,
  Panel,
  Select,
  StatusBadge,
  Textarea,
  TextInput,
  formatCount,
  formatDate,
  formatMoney,
} from "@krakatausteel/ui";
import { catatPencairan, daftarAkunKas, type BarisAkad } from "../../api/pumk";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useRouter } from "../../router";
import { AkadPicker } from "./AkadPicker";
import {
  Bagian,
  BarisAksi,
  CatatanOtorisasi,
  CatatanPencatatan,
  FieldGrid,
  FormLayout,
  hariIni,
  KembaliKeAntrean,
  PumkPage,
  usePilihan,
} from "./parts";

export function PencairanForm({ route }: { route: PageRoute }) {
  const { navigate } = useRouter();
  const [akadId, setAkadId] = usePilihan("akad");
  const [akad, setAkad] = useState<BarisAkad | null>(null);

  const akunKas = useApi(() => daftarAkunKas(), []);
  const [tanggal, setTanggal] = useState(hariIni());
  const [jumlah, setJumlah] = useState("");
  const [jumlahTerbaca, setJumlahTerbaca] = useState(true);
  const [akun, setAkun] = useState("");
  const [noBukti, setNoBukti] = useState("");
  const [keterangan, setKeterangan] = useState("");
  const [konfirmasi, setKonfirmasi] = useState(false);
  const kirim = useAction(catatPencairan);

  useEffect(() => {
    if (akad) setJumlah(akad.pokokPinjaman);
  }, [akad?.id]);

  const akunOptions = [
    { value: "", label: "Pilih akun kas atau bank" },
    ...(akunKas.data?.data ?? []).map((item) => ({
      value: item.id,
      label: `${item.kode} ${item.nama}`,
    })),
  ];

  const cocok = akad === null || jumlah === "" ? true : jumlah === akad.pokokPinjaman;
  const lengkap = jumlah !== "" && jumlahTerbaca && akun !== "" && tanggal !== "";

  async function simpan() {
    if (!akadId || !lengkap) return;
    const hasil = await kirim.jalankan({
      akadId,
      tanggalPencairan: tanggal,
      jumlah,
      akunKasId: akun,
      noBukti: noBukti.trim() || null,
      keterangan: keterangan.trim() || null,
    });
    if (hasil) {
      setKonfirmasi(false);
      navigate(`/pumk/kartu-piutang/${akadId}`);
    }
  }

  if (akadId === null) {
    return (
      <PumkPage route={route}>
        <AkadPicker
          title="Pilih akad yang akan dicairkan"
          description="Hanya akad yang jadwal angsurannya sudah siap yang dapat dicairkan."
          emptyTitle="Belum ada akad yang siap dicairkan"
          emptyDescription="Akad siap dicairkan setelah jadwal angsuran dibentuk."
          onPilih={(baris) => {
            setAkad(baris);
            setAkadId(baris.id);
          }}
        />
        <CatatanPencatatan />
        <CatatanOtorisasi />
      </PumkPage>
    );
  }

  return (
    <PumkPage
      route={route}
      title={akad ? `Pencairan akad ${akad.noAkad}` : route.title}
      sub={akad ? `${akad.mitraNama} . ${akad.cabangNama}` : route.summary}
      back={{ to: "/pumk/pencairan", label: "Pilih akad lain" }}
    >
      <FormLayout
        form={
          <div className="form-main">
            <Bagian
              title="Data pencairan"
              description="Nilai pencairan harus sama dengan pokok pinjaman pada akad. Engine menolak selisih apa pun."
            >
              <FieldGrid>
                <Field label="Tanggal pencairan" htmlFor="tanggal-cair" required>
                  <TextInput
                    id="tanggal-cair"
                    type="date"
                    value={tanggal}
                    onChange={(event) => setTanggal(event.currentTarget.value)}
                  />
                </Field>
                <Field
                  label="Jumlah dicairkan"
                  htmlFor="jumlah-cair"
                  required
                  error={
                    !jumlahTerbaca
                      ? "Nilai tidak terbaca sebagai angka rupiah."
                      : cocok
                        ? undefined
                        : "Nilai berbeda dari pokok pinjaman akad."
                  }
                >
                  <MoneyInput
                    id="jumlah-cair"
                    value={jumlah}
                    invalid={!jumlahTerbaca || !cocok}
                    onValueChange={(value, raw) => {
                      setJumlah(value ?? "");
                      setJumlahTerbaca(raw.trim() === "" || value !== null);
                    }}
                  />
                </Field>
                <Field
                  label="Akun kas atau bank"
                  htmlFor="akun-kas"
                  required
                  hint={
                    akunKas.status === "gagal"
                      ? "Daftar akun kas tidak dapat dibaca dari server, jadi pencairan tidak bisa disimpan."
                      : "Hanya akun berflag kas yang muncul di sini."
                  }
                >
                  <Select
                    id="akun-kas"
                    value={akun}
                    disabled={akunKas.status !== "siap"}
                    onChange={(event) => setAkun(event.currentTarget.value)}
                    options={akunOptions}
                  />
                </Field>
                <Field label="Nomor bukti" htmlFor="no-bukti">
                  <TextInput
                    id="no-bukti"
                    value={noBukti}
                    onChange={(event) => setNoBukti(event.currentTarget.value)}
                  />
                </Field>
              </FieldGrid>
              <Field label="Keterangan" htmlFor="keterangan-cair">
                <Textarea
                  id="keterangan-cair"
                  rows={2}
                  value={keterangan}
                  onChange={(event) => setKeterangan(event.currentTarget.value)}
                />
              </Field>
            </Bagian>

            <BarisAksi
              error={kirim.error}
              secondary={<KembaliKeAntrean onClick={() => setAkadId(null)} />}
              primary={
                <Button
                  variant="primary"
                  disabled={!lengkap}
                  loading={kirim.status === "mengirim"}
                  loadingLabel="Menyimpan"
                  onClick={() => setKonfirmasi(true)}
                >
                  Catat pencairan
                </Button>
              }
            />
          </div>
        }
        aside={
          <aside className="form-aside">
            <Panel
              as="h2"
              title="Akad"
              aside={akad ? <StatusBadge status={akad.status} /> : undefined}
              footer={
                <span>
                  Setelah pencairan tercatat, akad menjadi aktif dan outstanding pokok terisi.
                </span>
              }
            >
              {akad ? (
                <DataList
                  items={[
                    { label: "No akad", value: akad.noAkad },
                    { label: "Mitra Binaan", value: akad.mitraNama },
                    { label: "Tanggal akad", value: formatDate(akad.tanggalAkad) },
                    { label: "Pokok pinjaman", value: formatMoney(akad.pokokPinjaman), numeric: true },
                    { label: "Tenor", value: `${formatCount(akad.tenorBulan)} bulan`, numeric: true },
                    { label: "Mulai angsuran", value: formatDate(akad.tanggalMulaiAngsuran) },
                  ]}
                />
              ) : (
                <p className="penjelasan">
                  Data akad dibaca ulang saat halaman ini dibuka dari daftar akad. Buka kembali
                  daftar akad bila ringkasan ini kosong.
                </p>
              )}
            </Panel>

            <Panel
              as="h2"
              title="Yang terjadi setelah disimpan"
              footer={<span>Jurnal dibentuk lewat event mapping, bukan diketik manual.</span>}
            >
              <ol className="langkah-list">
                <li>Pencairan tercatat pada akad ini beserta nomor bukti dan akun kasnya.</li>
                <li>Jurnal PENCAIRAN_PUMK terbentuk melalui event to journal mapping.</li>
                <li>Status proposal menjadi Dicairkan dan akad menjadi Aktif.</li>
                <li>Outstanding pokok akad terisi sebesar pokok pinjaman.</li>
              </ol>
            </Panel>
          </aside>
        }
      />

      <ConfirmDialog
        open={konfirmasi}
        title="Konfirmasi pencatatan pencairan"
        description="Aplikasi mencatat pencairan yang sudah terjadi di bank. Penyimpanan ini membentuk jurnal, bukan memindahkan dana."
        confirmLabel="Catat pencairan"
        loading={kirim.status === "mengirim"}
        error={kirim.error}
        onCancel={() => setKonfirmasi(false)}
        onConfirm={simpan}
      >
        <DataList
          items={[
            { label: "Akad", value: akad?.noAkad ?? akadId },
            { label: "Mitra Binaan", value: akad?.mitraNama ?? "Tidak diketahui" },
            { label: "Tanggal pencairan", value: formatDate(tanggal) },
            { label: "Jumlah", value: formatMoney(jumlah), numeric: true },
            { label: "Nomor bukti", value: noBukti.trim() || "Tidak diisi" },
          ]}
        />
      </ConfirmDialog>
      <CatatanPencatatan />
      <CatatanOtorisasi />
    </PumkPage>
  );
}

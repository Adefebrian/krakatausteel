// Penerimaan Angsuran, spec 9.1 and spec 7.2.
//
// The page does not compute the allocation and does not preview one. The
// waterfall order is configuration (`urutan_alokasi_setoran`, spec 5.4) and
// the arithmetic is the instalment engine's; a second implementation in the
// browser would be a second answer, and the one on screen would be the one
// nobody can reconcile. So the operator records the deposit, and the ALLOCATION
// THE ENGINE ACTUALLY MADE is what this page then shows, component by
// component, including the surplus that went to Kelebihan Pembayaran.
import { useState } from "react";
import {
  Button,
  ConfirmDialog,
  DataList,
  DataTable,
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
  type Column,
} from "@krakatausteel/ui";
import {
  daftarAkunKas,
  terimaAngsuran,
  type BarisAkad,
  type HasilAlokasi,
} from "../../api/pumk";
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

type Rincian = HasilAlokasi["rincian"][number];

const RINCIAN_COLUMNS: readonly Column<Rincian>[] = [
  { key: "angsuranKe", header: "Angsuran ke", type: "count", width: "120px" },
  { key: "pokokDialokasikan", header: "Pokok", type: "money" },
  { key: "jasaDialokasikan", header: "Jasa Administrasi", type: "money" },
  {
    key: "statusSetelah",
    header: "Status baris",
    width: "160px",
    render: (row) => <StatusBadge status={row.statusSetelah} />,
  },
];

export function AngsuranForm({ route }: { route: PageRoute }) {
  const { navigate } = useRouter();
  const [akadId, setAkadId] = usePilihan("akad");
  const [akad, setAkad] = useState<BarisAkad | null>(null);

  const akunKas = useApi(() => daftarAkunKas(), []);
  const [tanggal, setTanggal] = useState(hariIni());
  const [valuta, setValuta] = useState("");
  const [jumlah, setJumlah] = useState("");
  const [jumlahTerbaca, setJumlahTerbaca] = useState(true);
  const [akun, setAkun] = useState("");
  const [noBukti, setNoBukti] = useState("");
  const [keterangan, setKeterangan] = useState("");
  const [konfirmasi, setKonfirmasi] = useState(false);
  const kirim = useAction(terimaAngsuran);

  const lengkap = jumlah !== "" && jumlahTerbaca && akun !== "" && tanggal !== "";

  async function simpan() {
    if (!akadId || !lengkap) return;
    const hasil = await kirim.jalankan({
      akadId,
      tanggalTerima: tanggal,
      jumlah,
      akunKasId: akun,
      noBukti: noBukti.trim() || null,
      tanggalValuta: valuta || null,
      keterangan: keterangan.trim() || null,
    });
    if (hasil) {
      setKonfirmasi(false);
      setJumlah("");
      setNoBukti("");
    }
  }

  if (akadId === null) {
    return (
      <PumkPage route={route}>
        <AkadPicker
          title="Pilih akad penerima setoran"
          description="Setoran selalu dicatat pada satu akad. Setoran tanpa identitas pemilik dicatat sebagai Angsuran Belum Teridentifikasi melalui jurnal, bukan di halaman ini."
          status="AKTIF"
          emptyTitle="Belum ada akad aktif pada cabang ini"
          emptyDescription="Akad menjadi aktif setelah pencairan dicatat."
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

  const hasil = kirim.hasil;

  return (
    <PumkPage
      route={route}
      title={akad ? `Penerimaan angsuran ${akad.noAkad}` : route.title}
      sub={akad ? `${akad.mitraNama} . ${akad.cabangNama}` : route.summary}
      back={{ to: "/pumk/angsuran", label: "Pilih akad lain" }}
    >
      <FormLayout
        form={
          <div className="form-main">
            <Bagian
              title="Data setoran"
              description="Isi jumlah yang benar benar diterima. Alokasi ke tunggakan, pokok, dan Jasa Administrasi dihitung oleh engine sesuai urutan pada Parameter Sistem."
            >
              <FieldGrid>
                <Field label="Tanggal terima" htmlFor="tanggal-terima" required>
                  <TextInput
                    id="tanggal-terima"
                    type="date"
                    value={tanggal}
                    onChange={(event) => setTanggal(event.currentTarget.value)}
                  />
                </Field>
                <Field
                  label="Tanggal valuta"
                  htmlFor="tanggal-valuta"
                  hint="Kosongkan bila sama dengan tanggal terima."
                >
                  <TextInput
                    id="tanggal-valuta"
                    type="date"
                    value={valuta}
                    onChange={(event) => setValuta(event.currentTarget.value)}
                  />
                </Field>
                <Field
                  label="Jumlah diterima"
                  htmlFor="jumlah-setoran"
                  required
                  error={jumlahTerbaca ? undefined : "Nilai tidak terbaca sebagai angka rupiah."}
                >
                  <MoneyInput
                    id="jumlah-setoran"
                    value={jumlah}
                    invalid={!jumlahTerbaca}
                    onValueChange={(value, raw) => {
                      setJumlah(value ?? "");
                      setJumlahTerbaca(raw.trim() === "" || value !== null);
                    }}
                  />
                </Field>
                <Field
                  label="Akun kas atau bank"
                  htmlFor="akun-setoran"
                  required
                  hint={
                    akunKas.status === "gagal"
                      ? "Daftar akun kas tidak dapat dibaca dari server, jadi setoran tidak bisa disimpan."
                      : "Hanya akun berflag kas yang muncul di sini."
                  }
                >
                  <Select
                    id="akun-setoran"
                    value={akun}
                    disabled={akunKas.status !== "siap"}
                    onChange={(event) => setAkun(event.currentTarget.value)}
                    options={[
                      { value: "", label: "Pilih akun kas atau bank" },
                      ...(akunKas.data?.data ?? []).map((item) => ({
                        value: item.id,
                        label: `${item.kode} ${item.nama}`,
                      })),
                    ]}
                  />
                </Field>
              </FieldGrid>
              <Field label="Nomor bukti setoran" htmlFor="bukti-setoran">
                <TextInput
                  id="bukti-setoran"
                  value={noBukti}
                  onChange={(event) => setNoBukti(event.currentTarget.value)}
                />
              </Field>
              <Field label="Keterangan" htmlFor="keterangan-setoran">
                <Textarea
                  id="keterangan-setoran"
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
                  Catat penerimaan
                </Button>
              }
            />

            {hasil ? (
              <Panel
                as="h2"
                title="Alokasi yang dibentuk engine"
                description="Angka di bawah adalah hasil alokasi yang benar benar tersimpan, bukan perkiraan halaman ini."
                footer={
                  <span>
                    Urutan komponen yang dipakai: {hasil.urutanKomponenDipakai.join(", ")}. Satu
                    setoran menghasilkan tepat satu jurnal.
                  </span>
                }
              >
                <DataList
                  columns={2}
                  items={[
                    { label: "Jumlah diterima", value: formatMoney(hasil.jumlahDiterima), numeric: true },
                    { label: "Alokasi pokok", value: formatMoney(hasil.alokasiPokok), numeric: true },
                    { label: "Alokasi Jasa Administrasi", value: formatMoney(hasil.alokasiJasa), numeric: true },
                    {
                      label: "Kelebihan pembayaran",
                      value: formatMoney(hasil.alokasiKelebihan),
                      numeric: true,
                    },
                    {
                      label: "Outstanding pokok setelah",
                      value: formatMoney(hasil.akadSetelah.outstandingPokok),
                      numeric: true,
                    },
                    {
                      label: "Outstanding jasa setelah",
                      value: formatMoney(hasil.akadSetelah.outstandingJasa),
                      numeric: true,
                    },
                  ]}
                />
                <DataTable
                  columns={RINCIAN_COLUMNS}
                  rows={hasil.rincian}
                  rowKey={(row) => row.jadwalId}
                  caption="Rincian alokasi per baris jadwal"
                  emptyTitle="Tidak ada baris jadwal yang terpengaruh"
                  emptyDescription="Seluruh setoran masuk ke Kelebihan Pembayaran Angsuran."
                />
                <div className="aksi-list">
                  <Button variant="secondary" onClick={() => navigate(`/pumk/kartu-piutang/${akadId}`)}>
                    Buka Kartu Piutang
                  </Button>
                </div>
              </Panel>
            ) : null}
          </div>
        }
        aside={
          <aside className="form-aside">
            <Panel
              as="h2"
              title="Akad"
              aside={akad ? <StatusBadge status={akad.status} /> : undefined}
              footer={<span>Piutang tidak pernah menjadi negatif. Kelebihan setoran ditahan.</span>}
            >
              {akad ? (
                <DataList
                  items={[
                    { label: "No akad", value: akad.noAkad },
                    { label: "Mitra Binaan", value: akad.mitraNama },
                    { label: "Outstanding pokok", value: formatMoney(akad.outstandingPokok), numeric: true },
                    { label: "Outstanding jasa", value: formatMoney(akad.outstandingJasa), numeric: true },
                    { label: "Hari tunggakan", value: formatCount(akad.hariTunggakan), numeric: true },
                    { label: "Tanggal akad", value: formatDate(akad.tanggalAkad) },
                  ]}
                />
              ) : (
                <p className="penjelasan">
                  Ringkasan akad terisi saat halaman dibuka dari daftar akad.
                </p>
              )}
            </Panel>
          </aside>
        }
      />

      <ConfirmDialog
        open={konfirmasi}
        title="Konfirmasi penerimaan angsuran"
        description="Aplikasi mencatat setoran yang sudah diterima. Penyimpanan ini membentuk jurnal penerimaan, bukan memindahkan dana."
        confirmLabel="Catat penerimaan"
        loading={kirim.status === "mengirim"}
        error={kirim.error}
        onCancel={() => setKonfirmasi(false)}
        onConfirm={simpan}
      >
        <DataList
          items={[
            { label: "Akad", value: akad?.noAkad ?? akadId },
            { label: "Tanggal terima", value: formatDate(tanggal) },
            { label: "Jumlah diterima", value: formatMoney(jumlah), numeric: true },
            { label: "Nomor bukti", value: noBukti.trim() || "Tidak diisi" },
          ]}
        />
      </ConfirmDialog>
      <CatatanPencatatan />
      <CatatanOtorisasi />
    </PumkPage>
  );
}

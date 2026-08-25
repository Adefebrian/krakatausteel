// Kalkulator Simulasi Angsuran, spec 7.4 and spec 9.1.
//
// It stores nothing and it books nothing. What it must NOT do is compute:
// spec 7.5 item 11 requires the simulated table and the generated table to be
// identical, and that only holds when one engine produces both. So the inputs
// go to the same instalment engine the real schedule comes from, and the table
// below is that engine's answer.
import { useState } from "react";
import {
  Bento,
  BentoItem,
  Button,
  ErrorState,
  Field,
  MoneyInput,
  Panel,
  Select,
  Stat,
  TextInput,
  formatMoney,
  formatRate,
  parseRate,
} from "@krakatausteel/ui";
import { batasanPumk, simulasiJadwal, type MetodePerhitungan } from "../../api/pumk";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { JadwalTabel, ParameterPanel, RingkasanJadwalPanel } from "./JadwalTabel";
import { Bagian, BarisAksi, FieldGrid, FormLayout, hariIni, PumkPage } from "./parts";

const METODE: Array<{ value: MetodePerhitungan; label: string }> = [
  { value: "FLAT", label: "Flat" },
  { value: "EFEKTIF", label: "Efektif" },
  { value: "ANUITAS", label: "Anuitas" },
];

export function Simulasi({ route }: { route: PageRoute }) {
  const batas = useApi(() => batasanPumk(), []);

  const [pokok, setPokok] = useState("");
  const [pokokTerbaca, setPokokTerbaca] = useState(true);
  const [rate, setRate] = useState("3");
  const [metode, setMetode] = useState<MetodePerhitungan>("FLAT");
  const [tenor, setTenor] = useState("12");
  const [grace, setGrace] = useState("0");
  const [mulai, setMulai] = useState(hariIni());

  const hitung = useAction(simulasiJadwal);
  const rateTerbaca = parseRate(rate) !== null;
  const lengkap = pokok !== "" && pokokTerbaca && rateTerbaca && tenor !== "" && mulai !== "";

  async function jalankan(event: React.FormEvent) {
    event.preventDefault();
    if (!lengkap) return;
    await hitung.jalankan({
      pokok,
      rate: parseRate(rate) ?? "0.000000",
      metode,
      tenorBulan: Number(tenor),
      gracePeriodBulan: Number(grace || "0"),
      tanggalMulaiAngsuran: mulai,
    });
  }

  const hasil = hitung.hasil;

  return (
    <PumkPage route={route}>
      <FormLayout
        form={
          <form className="form-main" onSubmit={jalankan}>
            <Bagian
              title="Parameter simulasi"
              description="Hasil dihitung oleh engine angsuran yang sama dengan jadwal sungguhan, sehingga angkanya identik dengan jadwal yang nanti terbentuk."
            >
              <FieldGrid>
                <Field
                  label="Plafon"
                  htmlFor="sim-pokok"
                  required
                  hint={
                    batas.data
                      ? `Batas program ${formatMoney(batas.data.plafonMin)} sampai ${formatMoney(batas.data.plafonMax)}.`
                      : undefined
                  }
                  error={pokokTerbaca ? undefined : "Nilai tidak terbaca sebagai angka rupiah."}
                >
                  <MoneyInput
                    id="sim-pokok"
                    value={pokok}
                    invalid={!pokokTerbaca}
                    onValueChange={(value, raw) => {
                      setPokok(value ?? "");
                      setPokokTerbaca(raw.trim() === "" || value !== null);
                    }}
                  />
                </Field>
                <Field
                  label="Rate Jasa Administrasi (persen per tahun)"
                  htmlFor="sim-rate"
                  required
                  hint={
                    batas.data
                      ? `Default Parameter Sistem ${formatRate(batas.data.jasaAdmRateDefault)} persen.`
                      : undefined
                  }
                  error={rateTerbaca ? undefined : "Rate tidak terbaca. Contoh penulisan: 3 atau 3,5."}
                >
                  <TextInput
                    id="sim-rate"
                    inputMode="decimal"
                    value={rate}
                    invalid={!rateTerbaca}
                    onChange={(event) => setRate(event.currentTarget.value)}
                  />
                </Field>
                <Field label="Metode perhitungan" htmlFor="sim-metode" required>
                  <Select
                    id="sim-metode"
                    value={metode}
                    onChange={(event) => setMetode(event.currentTarget.value as MetodePerhitungan)}
                    options={METODE}
                  />
                </Field>
                <Field label="Tenor (bulan)" htmlFor="sim-tenor" required>
                  <TextInput
                    id="sim-tenor"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={tenor}
                    onChange={(event) => setTenor(event.currentTarget.value)}
                  />
                </Field>
                <Field label="Grace period (bulan)" htmlFor="sim-grace">
                  <TextInput
                    id="sim-grace"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={grace}
                    onChange={(event) => setGrace(event.currentTarget.value)}
                  />
                </Field>
                <Field label="Tanggal mulai angsuran" htmlFor="sim-mulai" required>
                  <TextInput
                    id="sim-mulai"
                    type="date"
                    value={mulai}
                    onChange={(event) => setMulai(event.currentTarget.value)}
                  />
                </Field>
              </FieldGrid>
            </Bagian>

            <BarisAksi
              primary={
                <Button
                  type="submit"
                  variant="primary"
                  disabled={!lengkap}
                  loading={hitung.status === "mengirim"}
                  loadingLabel="Menghitung"
                >
                  Hitung simulasi
                </Button>
              }
            />
          </form>
        }
        aside={
          <aside className="form-aside">
            <Panel
              as="h2"
              title="Sifat halaman ini"
              footer={<span>Tidak ada data tersimpan dan tidak ada jurnal terbentuk.</span>}
            >
              <p className="penjelasan">
                Simulasi dipakai untuk menjawab pertanyaan calon Mitra Binaan. Perhitungan dilakukan
                oleh engine angsuran, sehingga jadwal yang muncul di sini sama persis dengan jadwal
                yang terbentuk bila pengajuan benar benar diproses dengan parameter yang sama.
              </p>
            </Panel>
            {hasil ? (
              <Panel
                as="h2"
                title="Ringkasan hasil"
                footer={<span>Selisih pembulatan dibebankan ke angsuran terakhir.</span>}
              >
                <RingkasanJadwalPanel ringkasan={hasil.ringkasan} />
              </Panel>
            ) : null}
          </aside>
        }
      />

      {hitung.status === "gagal" ? (
        <ErrorState
          title="Simulasi tidak dapat dihitung"
          detail={hitung.error}
          sumber="POST /api/pumk/simulasi"
          onRetry={() => hitung.reset()}
          retryLabel="Tutup pesan"
        />
      ) : null}

      {hasil ? (
        <>
          <Bento columns={4}>
            <BentoItem span="sm">
              <Panel as="h2" title="Angsuran per bulan" className="panel-kpi">
                <Stat
                  label="Baris pertama yang memuat pokok"
                  value={formatMoney(hasil.ringkasan.angsuranPerBulan)}
                  hint="Bukan rata rata, dan bukan baris terakhir."
                />
              </Panel>
            </BentoItem>
            <BentoItem span="sm">
              <Panel as="h2" title="Total pokok" className="panel-kpi">
                <Stat
                  label="Seluruh baris"
                  value={formatMoney(hasil.ringkasan.totalPokok)}
                  hint="Sama dengan plafon yang disimulasikan."
                />
              </Panel>
            </BentoItem>
            <BentoItem span="sm">
              <Panel as="h2" title="Total Jasa Administrasi" className="panel-kpi">
                <Stat
                  label="Seluruh baris"
                  value={formatMoney(hasil.ringkasan.totalJasa)}
                  hint={`Metode ${hasil.parameterTerpakai.metode}`}
                />
              </Panel>
            </BentoItem>
            <BentoItem span="sm">
              <Panel as="h2" title="Total dibayar" className="panel-kpi">
                <Stat
                  label="Pokok ditambah Jasa Administrasi"
                  value={formatMoney(hasil.ringkasan.totalBayar)}
                  hint={`${hasil.ringkasan.jumlahBaris} baris angsuran`}
                />
              </Panel>
            </BentoItem>
          </Bento>

          <Panel
            as="h2"
            title="Jadwal hasil simulasi"
            description="Tabel ini tidak disimpan. Cetak atau catat bila perlu ditunjukkan kepada calon Mitra Binaan."
            footer={<span>Total pokok wajib sama dengan plafon yang disimulasikan.</span>}
          >
            <JadwalTabel baris={hasil.baris} caption="Jadwal hasil simulasi" />
          </Panel>

          <Panel
            as="h2"
            title="Parameter yang dipakai engine"
            description="Nilai yang benar benar dipakai setelah resolusi konfigurasi, termasuk pembulatan dan kebijakan jasa saat grace period."
            footer={<span>Sumber: Parameter Sistem, bukan nilai tetap di dalam aplikasi.</span>}
          >
            <ParameterPanel parameter={hasil.parameterTerpakai} />
          </Panel>
        </>
      ) : null}
    </PumkPage>
  );
}

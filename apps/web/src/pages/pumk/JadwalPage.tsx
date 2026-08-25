// Jadwal Angsuran, spec 9.1: "tampilkan semua versi, tandai yang aktif".
//
// Every version is listed, oldest to newest, and the one the akad is actually
// being collected against carries the active marker. A superseded version is
// not hidden and not greyed into illegibility: a reschedule is a fact about
// the akad, and the version it replaced is the evidence of what changed.
import { useState } from "react";
import {
  Bento,
  BentoItem,
  Panel,
  Stat,
  StatusBadge,
  Tabs,
  TabPanel,
  formatCount,
  formatMoney,
} from "@krakatausteel/ui";
import { riwayatJadwal, type BarisAkad } from "../../api/pumk";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { AkadPicker } from "./AkadPicker";
import { JadwalTabel, ParameterPanel, RingkasanJadwalPanel } from "./JadwalTabel";
import {
  CatatanOtorisasi,
  Muat,
  PumkPage,
  RingkasDokumen,
  usePilihan,
} from "./parts";

export function JadwalPage({ route }: { route: PageRoute }) {
  const [akadId, setAkadId] = usePilihan("akad");
  const [akad, setAkad] = useState<BarisAkad | null>(null);
  const [versiAktif, setVersiAktif] = useState<string | null>(null);

  const riwayat = useApi(() => riwayatJadwal(akadId ?? ""), [akadId], {
    enabled: akadId !== null,
  });

  function pilih(baris: BarisAkad) {
    setAkad(baris);
    setAkadId(baris.id);
  }

  if (akadId === null) {
    return (
      <PumkPage route={route}>
        <AkadPicker
          title="Pilih akad"
          description="Jadwal angsuran selalu milik satu akad. Cari akad berdasarkan nomor, nama Mitra Binaan, atau NIK."
          emptyTitle="Belum ada akad pada cabang ini"
          emptyDescription="Akad terbentuk setelah proposal disetujui dan realisasi akad dicatat."
          onPilih={pilih}
        />
        <CatatanOtorisasi />
      </PumkPage>
    );
  }

  return (
    <PumkPage
      route={route}
      title={akad ? `Jadwal Angsuran ${akad.noAkad}` : route.title}
      sub={akad ? `${akad.mitraNama} . ${akad.cabangNama}` : route.summary}
      back={{ to: "/pumk/jadwal", label: "Pilih akad lain" }}
    >
      <Muat
        hasil={riwayat}
        judul="riwayat jadwal"
        sumber={`GET /api/pumk/akad/${akadId}/jadwal`}
      >
        {(data) => {
          const versi = [...data.data].sort((a, b) => b.versi - a.versi);
          const aktif = versi.find((item) => item.isActiveVersion) ?? versi[0];
          const dipilih =
            versi.find((item) => String(item.versi) === versiAktif) ?? aktif ?? null;

          if (!dipilih) {
            return (
              <Panel
                as="h2"
                title="Belum ada jadwal"
                footer={<span>Jadwal dibentuk oleh engine angsuran, bukan diketik manual.</span>}
              >
                <p className="penjelasan">
                  Akad ini belum memiliki jadwal angsuran. Jadwal dibentuk pada langkah generate
                  jadwal setelah akad dibuat.
                </p>
              </Panel>
            );
          }

          return (
            <>
              <RingkasDokumen
                items={[
                  { label: "Versi tersedia", value: formatCount(versi.length) },
                  { label: "Versi aktif", value: aktif ? formatCount(aktif.versi) : "Tidak ada" },
                  { label: "Baris jadwal", value: formatCount(dipilih.baris.length) },
                ]}
              />

              <Bento columns={4}>
                <BentoItem span="sm">
                  <Panel as="h2" title="Total pokok" className="panel-kpi">
                    <Stat
                      label="Seluruh baris versi ini"
                      value={formatMoney(dipilih.ringkasan.totalPokok)}
                      hint="Wajib sama persis dengan pokok pinjaman akad."
                    />
                  </Panel>
                </BentoItem>
                <BentoItem span="sm">
                  <Panel as="h2" title="Total Jasa Administrasi" className="panel-kpi">
                    <Stat
                      label="Seluruh baris versi ini"
                      value={formatMoney(dipilih.ringkasan.totalJasa)}
                      hint={`Metode ${dipilih.parameterTerpakai.metode}`}
                    />
                  </Panel>
                </BentoItem>
                <BentoItem span="sm">
                  <Panel as="h2" title="Angsuran per bulan" className="panel-kpi">
                    <Stat
                      label="Baris pertama yang memuat pokok"
                      value={formatMoney(dipilih.ringkasan.angsuranPerBulan)}
                      hint="Selisih pembulatan dibebankan ke angsuran terakhir."
                    />
                  </Panel>
                </BentoItem>
                <BentoItem span="sm">
                  <Panel as="h2" title="Total dibayar" className="panel-kpi">
                    <Stat
                      label="Pokok ditambah Jasa Administrasi"
                      value={formatMoney(dipilih.ringkasan.totalBayar)}
                      hint={`${formatCount(dipilih.ringkasan.jumlahBaris)} baris angsuran`}
                    />
                  </Panel>
                </BentoItem>
              </Bento>

              <Tabs
                label="Versi jadwal"
                active={String(dipilih.versi)}
                onChange={setVersiAktif}
                items={versi.map((item) => ({
                  id: String(item.versi),
                  label: item.isActiveVersion ? `Versi ${item.versi} (aktif)` : `Versi ${item.versi}`,
                  count: item.baris.length,
                }))}
                aside={
                  <StatusBadge
                    status={dipilih.isActiveVersion ? "AKTIF" : "SUPERSEDED"}
                    tone={dipilih.isActiveVersion ? "success" : "neutral"}
                    label={dipilih.isActiveVersion ? "Versi aktif" : "Versi lama, sudah digantikan"}
                  />
                }
              />

              <TabPanel id={String(dipilih.versi)}>
                <Panel
                  as="h2"
                  title={`Jadwal versi ${dipilih.versi}`}
                  description={
                    dipilih.isActiveVersion
                      ? "Versi yang dipakai untuk menagih dan menghitung tunggakan."
                      : "Versi lama. Riwayatnya tetap utuh dan tidak dapat diubah."
                  }
                  footer={
                    <span>
                      Jadwal bersifat immutable. Perubahan hanya terjadi melalui reschedule, yang
                      membentuk versi baru.
                    </span>
                  }
                >
                  <JadwalTabel
                    baris={dipilih.baris}
                    caption={`Jadwal angsuran versi ${dipilih.versi}`}
                  />
                </Panel>

                <Bento columns={2}>
                  <BentoItem span="sm">
                    <Panel
                      as="h2"
                      title="Ringkasan versi ini"
                      footer={<span>Dihitung oleh engine angsuran, bukan oleh halaman ini.</span>}
                    >
                      <RingkasanJadwalPanel ringkasan={dipilih.ringkasan} />
                    </Panel>
                  </BentoItem>
                  <BentoItem span="sm">
                    <Panel
                      as="h2"
                      title="Parameter yang dipakai"
                      footer={<span>Nilai ini dibaca dari Parameter Sistem saat jadwal dibentuk.</span>}
                    >
                      <ParameterPanel parameter={dipilih.parameterTerpakai} />
                    </Panel>
                  </BentoItem>
                </Bento>
              </TabPanel>
            </>
          );
        }}
      </Muat>
      <CatatanOtorisasi />
    </PumkPage>
  );
}

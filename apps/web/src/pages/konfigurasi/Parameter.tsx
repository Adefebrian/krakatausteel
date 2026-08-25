// Parameter Sistem, spec 9.4. Every configurable value this product reads,
// with WHERE ITS SHIPPED DEFAULT CAME FROM printed next to it.
//
// WHY THAT COLUMN EXISTS. Some of these numbers are written in the
// specification. Some were chosen in a recorded decision. And some we
// INVENTED, because the contract left them undecided and the system could not
// run without a figure. The four Non PUMK limits are in that last group, and
// so is the grace period jasa policy and two integration switches.
//
// An accountant reading "Nilai maksimum bantuan Non PUMK 500.000.000,00" on
// this screen has no way of telling those three cases apart, and the
// consequence is not academic: a number we made up, read as settled policy,
// gets quoted in a meeting and becomes settled policy by accident. So every
// row says which of the three it is.
//
// TWO SEPARATE FACTS, NOT ONE, AND THE PAGE KEEPS THEM APART:
//
//   Asal nilai default  per catalogue ENTRY. Where the shipped default came
//                       from. It does NOT change when the value changes,
//                       because it is a fact about the default.
//   Perlu konfirmasi    per ROW and per entity. Whether THIS value still needs
//                       the client's written confirmation. It goes false the
//                       moment an operator types an override, because an
//                       explicit override is the confirmation.
//
// A value can be confirmed and still have been invented by us. Merging the two
// into one flag would lose exactly the case this screen was built for.
//
// QUIET, NOT ALARMING. An assumption is not an error. It is a number waiting
// for a written answer, and it is toned as a note.
import { useMemo, useState } from "react";
import {
  Bento,
  BentoItem,
  Panel,
  SearchInput,
  Select,
  Stat,
  StatusBadge,
  ASAL_NILAI,
  formatCount,
  formatDate,
} from "@krakatausteel/ui";
import { daftarKonfigurasi, type NilaiResolusi } from "../../api/konfigurasi";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import {
  CatatanOtorisasi,
  HalamanModul,
  Muat,
  Penyaring,
} from "../shared/parts";

const ASAL_OPTIONS = [
  { value: "", label: "Semua asal nilai" },
  { value: "SPEC", label: "Dari spesifikasi" },
  { value: "KEPUTUSAN", label: "Keputusan tercatat" },
  { value: "ASUMSI", label: "Asumsi kami" },
  { value: "TIDAK_DIKETAHUI", label: "Tidak diketahui" },
];

const KONFIRMASI_OPTIONS = [
  { value: "", label: "Semua baris" },
  { value: "PERLU", label: "Perlu konfirmasi klien" },
  { value: "SUDAH", label: "Tidak perlu konfirmasi" },
];

/** Group headings, spelled out. An unknown group falls back to its own key. */
const NAMA_GRUP: Record<string, string> = {
  jasa_adm: "Jasa Administrasi",
  angsuran: "Angsuran dan alokasi setoran",
  batasan: "Batasan program",
  akuntansi: "Kebijakan akuntansi",
  kolektibilitas: "Kolektibilitas",
  penyisihan: "Penyisihan piutang",
  periode: "Periode dan closing",
  integrasi: "Integrasi",
  nomor: "Penomoran dokumen",
  laporan: "Laporan",
};

function namaGrup(grup: string): string {
  return NAMA_GRUP[grup] ?? grup.replace(/_/g, " ");
}

/** The key without its group prefix, as a readable sentence. */
function namaKunci(kunci: string): string {
  return kunci.replace(/_/g, " ");
}

export function Parameter({ route }: { route: PageRoute }) {
  const daftar = useApi(() => daftarKonfigurasi(), []);

  const [cari, setCari] = useState("");
  const [asal, setAsal] = useState("");
  const [konfirmasi, setKonfirmasi] = useState("");

  const rows = daftar.data?.data ?? [];

  const terpilih = useMemo(() => {
    const teks = cari.trim().toLowerCase();
    return rows.filter((row) => {
      if (teks !== "" && !`${row.grup}.${row.kunci} ${row.nilai}`.toLowerCase().includes(teks)) {
        return false;
      }
      if (asal === "TIDAK_DIKETAHUI" && row.asalNilaiDefault !== null) return false;
      if (asal !== "" && asal !== "TIDAK_DIKETAHUI" && row.asalNilaiDefault !== asal) return false;
      if (konfirmasi === "PERLU" && !row.perluKonfirmasi) return false;
      if (konfirmasi === "SUDAH" && row.perluKonfirmasi) return false;
      return true;
    });
  }, [rows, cari, asal, konfirmasi]);

  const hitung = useMemo(() => {
    const per = (nilai: string | null) =>
      rows.filter((row) => row.asalNilaiDefault === nilai).length;
    return {
      spec: per("SPEC"),
      keputusan: per("KEPUTUSAN"),
      asumsi: per("ASUMSI"),
      tidakDiketahui: per(null),
      perluKonfirmasi: rows.filter((row) => row.perluKonfirmasi).length,
    };
  }, [rows]);

  const grup = useMemo(() => {
    const peta = new Map<string, NilaiResolusi[]>();
    for (const row of terpilih) {
      const isi = peta.get(row.grup);
      if (isi) isi.push(row);
      else peta.set(row.grup, [row]);
    }
    return [...peta.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [terpilih]);

  function reset() {
    setCari("");
    setAsal("");
    setKonfirmasi("");
  }

  return (
    <HalamanModul route={route}>
      <Muat hasil={daftar} judul="parameter sistem" sumber="GET /api/konfigurasi">
        {() => (
          <>
            <Bento columns={4}>
              <BentoItem span="sm">
                <Panel
                  as="h2"
                  title="Dari spesifikasi"
                  className="panel-kpi"
                  footer={<span>Angkanya tertulis pada dokumen spesifikasi.</span>}
                >
                  <Stat
                    label="Parameter"
                    value={formatCount(hitung.spec)}
                  />
                </Panel>
              </BentoItem>
              <BentoItem span="sm">
                <Panel
                  as="h2"
                  title="Keputusan tercatat"
                  className="panel-kpi"
                  footer={<span>Dipilih melalui keputusan yang terdokumentasi.</span>}
                >
                  <Stat
                    label="Parameter"
                    value={formatCount(hitung.keputusan)}
                  />
                </Panel>
              </BentoItem>
              <BentoItem span="sm">
                <Panel
                  as="h2"
                  title="Asumsi kami"
                  className="panel-kpi"
                  footer={<span>Menunggu konfirmasi tertulis dari klien.</span>}
                >
                  <Stat
                    label="Parameter"
                    value={formatCount(hitung.asumsi)}
                  />
                </Panel>
              </BentoItem>
              <BentoItem span="sm">
                <Panel
                  as="h2"
                  title="Perlu konfirmasi"
                  className="panel-kpi"
                  footer={<span>Berlaku per baris nilai, bukan per jenis parameter.</span>}
                >
                  <Stat
                    label="Baris nilai"
                    value={formatCount(hitung.perluKonfirmasi)}
                  />
                </Panel>
              </BentoItem>
            </Bento>

            <Penyaring
              ringkas={[
                asal ? (ASAL_OPTIONS.find((item) => item.value === asal)?.label ?? asal) : "Semua asal nilai",
                konfirmasi
                  ? (KONFIRMASI_OPTIONS.find((item) => item.value === konfirmasi)?.label ?? konfirmasi)
                  : "Semua baris",
                cari.trim() ? `Cari "${cari.trim()}"` : null,
              ]
                .filter(Boolean)
                .join(" . ")}
            >
              <div className="filterbar" role="search">
                <div className="filterbar-group is-grow">
                  <span className="filterbar-label">Cari parameter</span>
                  <SearchInput
                    label="Cari parameter"
                    placeholder="Grup, kunci, atau nilai"
                    value={cari}
                    onChange={(event) => setCari(event.currentTarget.value)}
                  />
                </div>
                <div className="filterbar-group">
                  <span className="filterbar-label">Asal nilai default</span>
                  <Select
                    aria-label="Asal nilai default"
                    value={asal}
                    onChange={(event) => setAsal(event.currentTarget.value)}
                    options={ASAL_OPTIONS}
                  />
                </div>
                <div className="filterbar-group">
                  <span className="filterbar-label">Konfirmasi klien</span>
                  <Select
                    aria-label="Konfirmasi klien"
                    value={konfirmasi}
                    onChange={(event) => setKonfirmasi(event.currentTarget.value)}
                    options={KONFIRMASI_OPTIONS}
                  />
                </div>
                <div className="filterbar-actions">
                  <button type="button" className="btn btn-ghost" onClick={reset}>
                    <span className="btn-label">Reset filter</span>
                  </button>
                </div>
              </div>
            </Penyaring>

            {grup.length === 0 ? (
              <Panel as="h2" title="Tidak ada parameter yang cocok">
                <p className="penjelasan">
                  Tidak ada parameter yang cocok dengan filter ini. Ubah kata kunci, asal nilai,
                  atau status konfirmasinya.
                </p>
              </Panel>
            ) : (
              grup.map(([nama, isi]) => (
                <Panel
                  as="h2"
                  key={nama}
                  title={namaGrup(nama)}
                  description={`Grup konfigurasi ${nama}.`}
                  footer={
                    <span>
                      {formatCount(isi.length)} parameter,{" "}
                      {formatCount(isi.filter((row) => row.asalNilaiDefault === "ASUMSI").length)}{" "}
                      di antaranya masih berupa asumsi kami.
                    </span>
                  }
                >
                  <ul className="param-list">
                    {isi.map((row) => (
                      <li className="param-item" key={`${row.grup}.${row.kunci}`}>
                        <div className="param-head">
                          <span className="param-kunci">{namaKunci(row.kunci)}</span>
                          <span className="param-tanda">
                            {row.asalNilaiDefault === null ? (
                              <StatusBadge
                                status="ASAL_TIDAK_DIKETAHUI"
                                tone="neutral"
                                label="Asal tidak diketahui"
                              />
                            ) : (
                              <StatusBadge status={row.asalNilaiDefault} />
                            )}
                            {row.perluKonfirmasi ? (
                              <StatusBadge
                                status="PERLU_KONFIRMASI"
                                tone="caution"
                                label="Perlu konfirmasi klien"
                              />
                            ) : null}
                            {/* Only the override gets a badge. "This is still
                                the shipped default" is the ordinary case and
                                is stated in the meta line below instead, so a
                                row carries at most two marks and the one that
                                matters stays the one that is noticed. */}
                            {row.override ? (
                              <StatusBadge status="OVERRIDE" tone="info" label="Nilai diubah" />
                            ) : null}
                          </span>
                        </div>
                        <p className="param-nilai">{row.nilai}</p>
                        <p className="param-meta">
                          {row.grup}.{row.kunci} .{" "}
                          {row.override ? "nilai diubah" : "masih nilai bawaan"} . versi{" "}
                          {formatCount(row.version)} . diubah {formatDate(row.diubahAt)}
                          {row.diubahOleh ? ` oleh ID pengguna ${row.diubahOleh.slice(0, 8)}` : ""}
                        </p>
                        {row.asalNilaiDefault === "ASUMSI" ? (
                          <p className="param-catatan">
                            Nilai bawaan parameter ini kami usulkan sendiri karena spesifikasi dan
                            klien belum menetapkannya. Tercatat pada daftar asumsi proyek dan masih
                            menunggu jawaban tertulis.
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </Panel>
              ))
            )}
            <Panel
              as="h2"
              title="Membaca kolom asal nilai"
              description="Asal nilai dan perlu konfirmasi adalah dua pernyataan yang berbeda, dan keduanya ditampilkan terpisah."
              footer={
                <span>
                  Sebuah nilai bisa sudah dikonfirmasi klien dan tetap berasal dari asumsi kami.
                  Karena itu keduanya tidak pernah digabung menjadi satu penanda.
                </span>
              }
            >
              <ol className="langkah-list">
                <li>
                  <strong>Dari spesifikasi</strong>: angkanya tertulis pada dokumen spesifikasi
                  sistem, jadi mengubahnya berarti menyimpang dari spesifikasi.
                </li>
                <li>
                  <strong>Keputusan tercatat</strong>: angkanya dipilih melalui keputusan rancang
                  bangun, catatan arsitektur, atau kajian regulasi yang terdokumentasi.
                </li>
                <li>
                  <strong>Asumsi kami</strong>: tidak ada dasar pada spesifikasi maupun keputusan
                  klien. Angka ini kami usulkan sendiri agar sistem dapat berjalan, dicatat pada
                  daftar asumsi proyek, dan masih menunggu jawaban tertulis klien. Jangan dikutip
                  sebagai kebijakan yang sudah disepakati.
                </li>
                <li>
                  <strong>Tidak diketahui</strong>: baris ini tidak ada pada katalog parameter, jadi
                  asal nilainya tidak dapat dinyatakan. Itu bukan pernyataan bahwa nilainya berasal
                  dari spesifikasi.
                </li>
              </ol>
              <p className="penjelasan">
                Nilai ditampilkan persis seperti tersimpan, bukan diformat sebagai rupiah. Jenis
                setiap parameter berbeda: ada yang berupa uang, ada yang berupa angka desimal,
                pilihan, benar salah, atau daftar, dan endpoint ini tidak menyatakan jenisnya. Teks
                mentah inilah yang dibaca engine, jadi menampilkannya apa adanya lebih jujur
                daripada menebak bahwa sebuah baris adalah nilai uang.
              </p>
            </Panel>
          </>
        )}
      </Muat>

      <CatatanOtorisasi tambahan="Perubahan parameter memerlukan hak akses tersendiri dan tercatat pada audit trail beserta nilai lama dan nilai barunya." />
    </HalamanModul>
  );
}

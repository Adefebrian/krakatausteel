// Input Proposal Pendanaan UMK, spec 9.1.
//
// Two things this form owes the operator, both of which spec 9.1 calls out:
//
//   1. FIND THE MITRA FIRST. A returning borrower is looked up by name or NIK
//      and the form fills itself from the record, so nobody retypes an
//      address and creates a second version of the same person.
//   2. SAY NO BEFORE THE FORM IS TYPED, NOT AFTER. The plafon bounds, the
//      tenor bounds and `maks_pinjaman_aktif_per_mitra` are read from
//      `konfigurasi` and checked as the operator types. The engine checks them
//      again, and the database has the partial unique index behind that; this
//      is the courtesy layer, not the control.
//
// When the bounds cannot be read the submit stays CLOSED. Fail closed: a form
// that submits an unvalidated plafon because the config endpoint was down
// would push the rejection to the engine, which is exactly the late refusal
// the spec complains about.
import { useState } from "react";
import {
  Button,
  DataList,
  ErrorState,
  Field,
  Icon,
  MoneyInput,
  Panel,
  Select,
  SearchInput,
  StatusBadge,
  Textarea,
  TextInput,
  formatCount,
  formatMoney,
  formatRupiah,
  bandingUang,
} from "@krakatausteel/ui";
import {
  batasanPumk,
  buatProposal,
  cariMitra,
  daftarSektor,
  type RingkasanMitra,
} from "../../api/pumk";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useRouter } from "../../router";
import { useActiveSession } from "../../session";
import {
  Bagian,
  BarisAksi,
  CatatanOtorisasi,
  FieldGrid,
  FormLayout,
  HalamanModul,
  hariIni,
  Muat,
} from "../shared/parts";

/**
 * `bandingUang` answers null when a side cannot be read, and here that answer
 * means the check did not run. Treating it as "within the limit" would open
 * the submit button over a bound nobody verified, so it becomes a problem of
 * its own instead.
 */
function melewati(kiri: string, kanan: string, arah: -1 | 1): boolean | null {
  const hasil = bandingUang(kiri, kanan);
  return hasil === null ? null : arah === 1 ? hasil > 0 : hasil < 0;
}

export function ProposalForm({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const { navigate } = useRouter();

  const [cari, setCari] = useState("");
  const [cariAktif, setCariAktif] = useState("");
  const [mitra, setMitra] = useState<RingkasanMitra | null>(null);
  const [sektorId, setSektorId] = useState("");
  const [tanggalProposal, setTanggalProposal] = useState(hariIni());
  const [jumlah, setJumlah] = useState("");
  const [jumlahTerbaca, setJumlahTerbaca] = useState(true);
  const [tenor, setTenor] = useState("");
  const [tujuan, setTujuan] = useState("");

  const batas = useApi(() => batasanPumk(), []);
  const sektor = useApi(() => daftarSektor(), []);
  const hasil = useApi(() => cariMitra(cariAktif, session.cabang.id), [cariAktif], {
    enabled: cariAktif.trim().length >= 3,
  });
  const simpan = useAction(buatProposal);

  const batasan = batas.data;
  const tenorAngka = Number(tenor);

  const masalah: string[] = [];
  if (batasan) {
    if (mitra && mitra.jumlahPinjamanAktif >= batasan.maksPinjamanAktifPerMitra) {
      masalah.push(
        `${mitra.namaLengkap} masih memiliki ${formatCount(mitra.jumlahPinjamanAktif)} pinjaman aktif, sedangkan batas maksimal adalah ${formatCount(batasan.maksPinjamanAktifPerMitra)} per Mitra Binaan. Selesaikan akad berjalan terlebih dahulu.`,
      );
    }
    const dibawahMin = jumlah ? melewati(jumlah, batasan.plafonMin, -1) : false;
    const diatasMax = jumlah ? melewati(jumlah, batasan.plafonMax, 1) : false;
    if (dibawahMin === null || diatasMax === null) {
      masalah.push(
        "Plafon minimum atau maksimum tidak terbaca sebagai angka rupiah, jadi nilai yang diajukan tidak dapat diperiksa terhadap batas program.",
      );
    }
    if (dibawahMin === true) {
      masalah.push(`Nilai yang diajukan di bawah plafon minimum ${formatRupiah(batasan.plafonMin)}.`);
    }
    if (diatasMax === true) {
      masalah.push(`Nilai yang diajukan melewati plafon maksimum ${formatRupiah(batasan.plafonMax)}.`);
    }
    if (tenor && (tenorAngka < batasan.tenorMin || tenorAngka > batasan.tenorMax)) {
      masalah.push(
        `Tenor harus antara ${formatCount(batasan.tenorMin)} dan ${formatCount(batasan.tenorMax)} bulan.`,
      );
    }
    if (jumlah && melewati(jumlah, batasan.wajibJaminanDiAtasPlafon, 1) === true) {
      masalah.push(
        `Nilai di atas ${formatRupiah(batasan.wajibJaminanDiAtasPlafon)} wajib disertai jaminan. Isi Profil Jaminan setelah proposal tersimpan sebagai draft.`,
      );
    }
  }

  const wajibJaminan =
    batasan && jumlah ? melewati(jumlah, batasan.wajibJaminanDiAtasPlafon, 1) === true : false;
  const pemblokir = masalah.filter((pesan) => !pesan.startsWith("Nilai di atas"));

  const lengkap =
    mitra !== null && jumlah !== "" && jumlahTerbaca && tenor !== "" && tanggalProposal !== "";
  const bolehSimpan = lengkap && batasan !== null && pemblokir.length === 0;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!bolehSimpan || !mitra) return;
    const proposal = await simpan.jalankan({
      cabangId: session.cabang.id,
      mitraId: mitra.id,
      sektorId: sektorId || mitra.sektorId || null,
      tanggalProposal,
      jumlahDiajukan: jumlah,
      tenorDiajukan: tenorAngka,
      tujuanPenggunaan: tujuan.trim() || null,
    });
    if (proposal) navigate(`/pumk/proposal/${proposal.id}`);
  }

  return (
    <HalamanModul route={route} back={{ to: "/pumk/proposal", label: "Daftar Proposal" }}>
      <FormLayout
        form={
          <form className="form-main" onSubmit={submit}>
            <Bagian
              title="1. Cari Mitra Binaan"
              description="Cari dengan nama atau NIK. Mitra yang pernah meminjam akan mengisi form ini secara otomatis, termasuk data usaha dan sektornya."
            >
              <div className="cari-mitra">
                <SearchInput
                  label="Cari nama atau NIK Mitra Binaan"
                  placeholder="Nama lengkap atau NIK"
                  value={cari}
                  onChange={(event) => setCari(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      setCariAktif(cari);
                    }
                  }}
                />
                <Button variant="secondary" onClick={() => setCariAktif(cari)}>
                  Cari
                </Button>
              </div>

              {cariAktif.trim().length >= 3 ? (
                <Muat hasil={hasil} judul="hasil pencarian mitra" sumber="GET /api/pumk/mitra">
                  {(data) =>
                    data.data.length === 0 ? (
                      <p className="penjelasan">
                        Tidak ada Mitra Binaan yang cocok. Daftarkan mitra baru melalui halaman
                        Mitra Binaan terlebih dahulu, lalu kembali ke form ini.
                      </p>
                    ) : (
                      <ul className="pilihan-list">
                        {data.data.map((kandidat) => (
                          <li key={kandidat.id}>
                            <button
                              type="button"
                              className={
                                mitra?.id === kandidat.id ? "pilihan-btn is-active" : "pilihan-btn"
                              }
                              onClick={() => {
                                setMitra(kandidat);
                                setSektorId(kandidat.sektorId ?? "");
                              }}
                            >
                              <span className="pilihan-judul">{kandidat.namaLengkap}</span>
                              <span className="pilihan-sub">
                                {kandidat.kodeMitra}
                                {kandidat.nik ? ` . NIK ${kandidat.nik}` : ""}
                                {kandidat.namaUsaha ? ` . ${kandidat.namaUsaha}` : ""}
                              </span>
                              <span className="pilihan-meta">
                                {formatCount(kandidat.jumlahPinjamanAktif)} pinjaman aktif,{" "}
                                {formatCount(kandidat.jumlahPinjamanSelesai)} selesai
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )
                  }
                </Muat>
              ) : (
                <p className="penjelasan">Ketik minimal tiga huruf, lalu tekan Cari.</p>
              )}
            </Bagian>

            <Bagian
              title="2. Data pengajuan"
              description="Nilai dan tenor diperiksa terhadap Parameter Sistem saat Anda mengetik, bukan setelah proposal dikirim."
            >
              <FieldGrid>
                <Field label="Tanggal proposal" htmlFor="tanggal-proposal" required>
                  <TextInput
                    id="tanggal-proposal"
                    type="date"
                    value={tanggalProposal}
                    onChange={(event) => setTanggalProposal(event.currentTarget.value)}
                  />
                </Field>
                <Field
                  label="Sektor usaha"
                  htmlFor="sektor"
                  hint={
                    sektor.status === "gagal"
                      ? "Daftar sektor tidak dapat dimuat dari server."
                      : "Terisi otomatis dari data mitra bila tersedia."
                  }
                >
                  <Select
                    id="sektor"
                    value={sektorId}
                    disabled={sektor.status === "gagal"}
                    onChange={(event) => setSektorId(event.currentTarget.value)}
                    options={[
                      { value: "", label: "Belum dipilih" },
                      ...(sektor.data?.data ?? []).map((item) => ({
                        value: item.id,
                        label: item.nama,
                      })),
                    ]}
                  />
                </Field>
                <Field
                  label="Jumlah diajukan"
                  htmlFor="jumlah"
                  required
                  hint={
                    batasan
                      ? `Plafon ${formatRupiah(batasan.plafonMin)} sampai ${formatRupiah(batasan.plafonMax)}.`
                      : "Batas plafon belum terbaca dari server."
                  }
                  error={jumlahTerbaca ? undefined : "Nilai tidak terbaca sebagai angka rupiah."}
                >
                  <MoneyInput
                    id="jumlah"
                    value={jumlah}
                    invalid={!jumlahTerbaca}
                    onValueChange={(value, raw) => {
                      setJumlah(value ?? "");
                      setJumlahTerbaca(raw.trim() === "" || value !== null);
                    }}
                  />
                </Field>
                <Field
                  label="Tenor (bulan)"
                  htmlFor="tenor"
                  required
                  hint={
                    batasan
                      ? `${formatCount(batasan.tenorMin)} sampai ${formatCount(batasan.tenorMax)} bulan.`
                      : "Batas tenor belum terbaca dari server."
                  }
                >
                  <TextInput
                    id="tenor"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={tenor}
                    onChange={(event) => setTenor(event.currentTarget.value)}
                  />
                </Field>
              </FieldGrid>
              <Field label="Tujuan penggunaan" htmlFor="tujuan">
                <Textarea
                  id="tujuan"
                  rows={3}
                  value={tujuan}
                  placeholder="Contoh: tambahan modal bahan baku dan satu unit mesin jahit"
                  onChange={(event) => setTujuan(event.currentTarget.value)}
                />
              </Field>
            </Bagian>

            <BarisAksi
              error={simpan.error}
              secondary={
                <Button variant="ghost" onClick={() => navigate("/pumk/proposal")}>
                  Batal
                </Button>
              }
              primary={
                <Button
                  type="submit"
                  variant="primary"
                  disabled={!bolehSimpan}
                  loading={simpan.status === "mengirim"}
                  loadingLabel="Menyimpan"
                >
                  Simpan sebagai draft
                </Button>
              }
            />
          </form>
        }
        aside={
          <aside className="form-aside">
            <Panel
              as="h2"
              title="Pemeriksaan sebelum kirim"
              description="Semua batas di bawah dibaca dari Parameter Sistem, bukan ditulis di aplikasi."
              footer={
                <span>
                  {bolehSimpan
                    ? "Semua syarat terpenuhi. Proposal akan tersimpan berstatus Draft."
                    : "Tombol simpan terbuka setelah seluruh syarat di atas terpenuhi."}
                </span>
              }
            >
              {batas.status === "gagal" ? (
                <ErrorState
                  title="Batas program tidak dapat dibaca"
                  description="Tanpa Parameter Sistem, aplikasi tidak bisa memeriksa plafon, tenor, dan batas pinjaman aktif. Penyimpanan sengaja ditutup daripada mengirim pengajuan yang belum diperiksa."
                  detail={batas.error}
                  sumber="GET /api/pumk/batasan"
                  onRetry={batas.reload}
                />
              ) : batas.status === "memuat" ? (
                <p className="muat-memuat" role="status">
                  Memuat batas program.
                </p>
              ) : batasan ? (
                <>
                  <DataList
                    items={[
                      { label: "Plafon minimum", value: formatMoney(batasan.plafonMin), numeric: true },
                      { label: "Plafon maksimum", value: formatMoney(batasan.plafonMax), numeric: true },
                      {
                        label: "Tenor",
                        value: `${formatCount(batasan.tenorMin)} sampai ${formatCount(batasan.tenorMax)} bulan`,
                      },
                      {
                        label: "Wajib jaminan di atas",
                        value: formatMoney(batasan.wajibJaminanDiAtasPlafon),
                        numeric: true,
                      },
                      {
                        label: "Maksimal pinjaman aktif",
                        value: formatCount(batasan.maksPinjamanAktifPerMitra),
                        numeric: true,
                      },
                    ]}
                  />
                  {masalah.length > 0 ? (
                    <ul className="periksa-list">
                      {masalah.map((pesan) => (
                        <li className="periksa-item" key={pesan}>
                          <Icon name="alert" size={16} />
                          <span>{pesan}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="periksa-ok">
                      <Icon name="checkCircle" size={16} />
                      <span>
                        {lengkap
                          ? "Nilai, tenor, dan status pinjaman mitra memenuhi batas program."
                          : "Belum ada pelanggaran batas. Lengkapi mitra, nilai, dan tenor."}
                      </span>
                    </p>
                  )}
                </>
              ) : null}
            </Panel>

            <Panel
              as="h2"
              title="Mitra Binaan terpilih"
              description="Data di bawah dibaca dari master mitra dan tidak diketik ulang pada form ini."
              aside={mitra ? <StatusBadge status={mitra.status} /> : undefined}
              footer={
                <span>
                  {mitra
                    ? mitra.isMitraLama
                      ? "Mitra lama. Riwayat pinjaman ikut diperhitungkan pada pemeriksaan di atas."
                      : "Mitra baru. Belum pernah menerima pinjaman PUMK."
                    : "Belum ada mitra dipilih."}
                </span>
              }
            >
              {mitra ? (
                <DataList
                  items={[
                    { label: "Kode mitra", value: mitra.kodeMitra },
                    { label: "NIK", value: mitra.nik ?? "Belum diisi" },
                    { label: "Nama usaha", value: mitra.namaUsaha ?? "Belum diisi" },
                    { label: "Sektor", value: mitra.sektorNama ?? "Belum diisi" },
                    { label: "Kota", value: mitra.kotaNama ?? "Belum diisi" },
                    { label: "Telepon", value: mitra.telepon ?? "Belum diisi" },
                    {
                      label: "Pinjaman aktif",
                      value: formatCount(mitra.jumlahPinjamanAktif),
                      numeric: true,
                    },
                    {
                      label: "Pinjaman selesai",
                      value: formatCount(mitra.jumlahPinjamanSelesai),
                      numeric: true,
                    },
                    { label: "Alamat", value: mitra.alamat ?? "Belum diisi", wide: true },
                  ]}
                />
              ) : (
                <p className="penjelasan">
                  Pilih satu mitra dari hasil pencarian untuk mengisi bagian ini.
                </p>
              )}
            </Panel>

            {wajibJaminan ? (
              <Panel
                as="h2"
                title="Jaminan wajib"
                description="Nilai yang diajukan melewati ambang wajib jaminan pada Parameter Sistem."
                footer={<span>Isi Profil Jaminan sebelum proposal diajukan ke Checker.</span>}
              >
                <p className="penjelasan">
                  Proposal tetap bisa disimpan sebagai draft. Jaminan dicatat pada halaman Profil
                  Jaminan, satu proposal dapat memiliki lebih dari satu jaminan.
                </p>
              </Panel>
            ) : null}
          </aside>
        }
      />
      <CatatanOtorisasi tambahan="Batas pinjaman aktif per mitra juga ditegakkan ulang oleh engine dan oleh basis data." />
    </HalamanModul>
  );
}

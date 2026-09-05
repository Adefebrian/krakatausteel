// Input Jurnal Kas Bank, spec 9.4 and spec 6.5. A cash receipt or a cash
// payment: one side is always an account the chart marks as cash or bank, and
// the other side is free.
//
// THE SAME ENGINE AS JURNAL UMUM, AND THE FORM IS WHAT DIFFERS. `POST /jurnal`
// with `jenis: "KAS_BANK"` runs one extra check and one only: at least one line
// must hit an account whose `is_kas` flag is set, refused with
// `KAS_BANK_TANPA_AKUN_KAS`. Everything else, balance included, is the same
// rule as every other journal. So this page splits the cash leg out into its
// own section, defaults its side from "penerimaan" or "pengeluaran", and leaves
// the counter lines to the same editor Jurnal Umum uses.
//
// THE CASH ACCOUNT PICKER OFFERS ONLY CASH ACCOUNTS, read from the chart's own
// `isKas` flag rather than from a name: any bank account the COA marks as cash
// satisfies the engine, and matching on the word "Kas" would quietly exclude
// half of them. If the operator picks an account the server does not consider
// cash, the refusal lands ON THIS FIELD rather than in a banner, because the
// field is what has to change.
//
// A RECEIPT IS NOT A TRANSFER OF MONEY. This application records an event that
// already happened at the bank; saving here forms a journal and moves nothing.
import { useMemo, useState } from "react";
import { Button, Field, Icon, MoneyInput, Panel, Select, TextInput } from "@krakatausteel/ui";
import type { PageRoute } from "../../nav";
import { useActiveSession } from "../../session";
import {
  BarisAksi,
  Bagian,
  CatatanOtorisasi,
  CatatanPencatatan,
  FieldGrid,
  HalamanModul,
  hariIni,
  Muat,
} from "../shared/parts";
import {
  BagianDokumen,
  barisKosong,
  CatatanAlurJurnal,
  EditorBaris,
  HasilDraft,
  hitungTotal,
  keInputBaris,
  keluhanForm,
  KeluhanForm,
  opsiAkun,
  pesanUntukKontrol,
  TotalBerjalan,
  useAkun,
  useKirimJurnal,
  type BarisForm,
} from "./parts";

type Arah = "PENERIMAAN" | "PENGELUARAN";

const OPSI_ARAH = [
  { value: "PENERIMAAN", label: "Penerimaan kas, kas bertambah" },
  { value: "PENGELUARAN", label: "Pengeluaran kas, kas berkurang" },
];

export function JurnalKasBank({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const akun = useAkun();
  const kirim = useKirimJurnal();

  const [cabangId, setCabangId] = useState(session.cabang.id);
  const [tanggal, setTanggal] = useState(hariIni());
  const [keterangan, setKeterangan] = useState("");

  const [arah, setArah] = useState<Arah>("PENERIMAAN");
  const [akunKas, setAkunKas] = useState("");
  const [jumlah, setJumlah] = useState("");
  const [jumlahTerbaca, setJumlahTerbaca] = useState(true);
  const [noBukti, setNoBukti] = useState("");
  const [lawan, setLawan] = useState<BarisForm[]>(() => [barisKosong("KREDIT")]);

  const daftarAkun = akun.data?.baris ?? [];
  const opsiKas = useMemo(
    () =>
      daftarAkun
        .filter((a) => a.isKas && a.isPostable && a.aktif)
        .map((a) => ({ value: a.akunId, label: `${a.kode} ${a.nama}` })),
    [daftarAkun],
  );

  /**
   * The cash leg, as a line. Its side is the DIRECTION: a receipt debits cash,
   * a payment credits it. That is the one thing this form knows that the free
   * editor does not, and it is why the direction is a control rather than a
   * position picker the operator can get backwards.
   */
  const barisKas: BarisForm = {
    kunci: "kas",
    akunId: akunKas,
    sisi: arah === "PENERIMAAN" ? "DEBIT" : "KREDIT",
    jumlah,
    terbaca: jumlahTerbaca,
    keterangan: noBukti.trim() === "" ? "" : `Bukti ${noBukti.trim()}`,
    mitraId: null,
    akadId: null,
  };

  const semua = [barisKas, ...lawan];
  const total = hitungTotal(semua);
  const keluhan = keluhanForm(semua, total);
  const siap = keluhan.length === 0 && tanggal !== "" && cabangId !== "";

  function ulangi() {
    kirim.reset();
    setAkunKas("");
    setJumlah("");
    setJumlahTerbaca(true);
    setNoBukti("");
    setKeterangan("");
    setLawan([barisKosong("KREDIT")]);
  }

  if (kirim.hasil) {
    return (
      <HalamanModul route={route}>
        <HasilDraft jurnal={kirim.hasil} onLagi={ulangi} />
        <CatatanPencatatan />
        <CatatanOtorisasi tambahan="Halaman ini memerlukan kewenangan jurnal.create." />
      </HalamanModul>
    );
  }

  return (
    <HalamanModul route={route}>
      <CatatanAlurJurnal />

      <BagianDokumen
        cabangId={cabangId}
        setCabangId={setCabangId}
        tanggal={tanggal}
        setTanggal={setTanggal}
        keterangan={keterangan}
        setKeterangan={setKeterangan}
        galat={kirim.galat}
      />

      <Bagian
        title="Sisi kas"
        description="Satu sisi dokumen ini wajib memakai akun yang ditandai kas atau bank pada Bagan Akun. Server menolak dokumen Kas Bank tanpa akun kas."
      >
        <Muat hasil={akun} judul="daftar akun kas" sumber="GET /api/laporan/bagan-akun">
          {() => (
            <>
              <FieldGrid>
                <Field label="Jenis transaksi kas" htmlFor="kas-arah" required>
                  <Select
                    id="kas-arah"
                    value={arah}
                    onChange={(event) => setArah(event.currentTarget.value as Arah)}
                    options={OPSI_ARAH}
                  />
                </Field>
                <Field
                  label="Akun kas atau bank"
                  htmlFor="kas-akun"
                  required
                  error={pesanUntukKontrol(kirim.kode, kirim.error, "akunKas")}
                  hint={
                    opsiKas.length === 0
                      ? "Tidak ada akun berflag kas yang aktif dan boleh diposting pada Bagan Akun."
                      : "Daftar ini mengikuti flag kas pada Bagan Akun, bukan nama akunnya."
                  }
                >
                  <Select
                    id="kas-akun"
                    value={akunKas}
                    onChange={(event) => setAkunKas(event.currentTarget.value)}
                    options={[{ value: "", label: "Pilih akun kas atau bank" }, ...opsiKas]}
                  />
                </Field>
                <Field
                  label="Jumlah"
                  htmlFor="kas-jumlah"
                  required
                  error={jumlahTerbaca ? undefined : "Nilai tidak terbaca sebagai angka rupiah."}
                >
                  <MoneyInput
                    id="kas-jumlah"
                    value={jumlah}
                    invalid={!jumlahTerbaca}
                    onValueChange={(nilai, mentah) => {
                      setJumlah(nilai ?? "");
                      setJumlahTerbaca(mentah.trim() === "" || nilai !== null);
                    }}
                  />
                </Field>
                <Field label="Nomor bukti kas" htmlFor="kas-bukti">
                  <TextInput
                    id="kas-bukti"
                    value={noBukti}
                    maxLength={120}
                    onChange={(event) => setNoBukti(event.currentTarget.value)}
                  />
                </Field>
              </FieldGrid>
              <p className="periksa-ok">
                <Icon name="check" size={16} />
                <span>
                  Sisi kas akan tercatat sebagai baris{" "}
                  {arah === "PENERIMAAN" ? "debit" : "kredit"} pada dokumen ini.
                </span>
              </p>
            </>
          )}
        </Muat>
      </Bagian>

      <Bagian
        title="Baris lawan"
        description="Sisi lawan bebas, boleh lebih dari satu baris. Totalnya harus sama dengan sisi kas."
      >
        <Muat hasil={akun} judul="bagan akun" sumber="GET /api/laporan/bagan-akun">
          {(data) => (
            <>
              <EditorBaris
                baris={lawan}
                onChange={setLawan}
                akun={data.baris}
                galat={geserGalat(kirim.galat)}
              />
              <TotalBerjalan total={total} />
            </>
          )}
        </Muat>
      </Bagian>

      <Panel
        as="h2"
        title="Simpan sebagai draft"
        description="Yang tersimpan adalah dokumen DRAFT. Menyimpan di sini membentuk jurnal, bukan memindahkan dana."
      >
        <KeluhanForm keluhan={keluhan} />
        <BarisAksi
          error={kirim.kode !== null && kirim.kode in FIELD_TERPETAKAN ? null : kirim.error}
          primary={
            <Button
              variant="primary"
              disabled={!siap || akun.status !== "siap"}
              loading={kirim.status === "mengirim"}
              leading={<Icon name="check" size={16} />}
              onClick={() =>
                void kirim.kirim({
                  cabangId,
                  jenis: "KAS_BANK",
                  tanggalTransaksi: tanggal,
                  keterangan: keterangan.trim() === "" ? null : keterangan.trim(),
                  baris: keInputBaris(semua),
                })
              }
            >
              Simpan draft jurnal kas bank
            </Button>
          }
          secondary={
            <Button variant="ghost" onClick={() => setLawan([barisKosong("KREDIT")])}>
              Kosongkan baris lawan
            </Button>
          }
        />
      </Panel>

      <CatatanPencatatan />
      <CatatanOtorisasi tambahan="Halaman ini memerlukan kewenangan jurnal.create." />
    </HalamanModul>
  );
}

/** Codes this page routes onto a control instead of into the error row. */
const FIELD_TERPETAKAN: Record<string, true> = { KAS_BANK_TANPA_AKUN_KAS: true };

/**
 * The cash leg is line 0 in the request, so a server message about the counter
 * lines arrives one index higher than the editor's own numbering.
 *
 * IT IS SHIFTED RATHER THAN SHOWN AS SENT, because a message about "baris 2"
 * landing on the operator's first counter line is a message that sends them to
 * the wrong row. Nothing is reworded; only the index is translated back into
 * the numbering the person is looking at.
 */
function geserGalat(
  galat: Record<string, string[]> | null,
): Record<string, string[]> | null {
  if (galat === null) return null;
  const keluar: Record<string, string[]> = {};
  for (const [kunci, pesan] of Object.entries(galat)) {
    const cocok = /^baris\.(\d+)\.(.+)$/.exec(kunci);
    if (!cocok) {
      keluar[kunci] = pesan;
      continue;
    }
    const index = Number(cocok[1]);
    if (index === 0) continue;
    keluar[`baris.${index - 1}.${cocok[2]}`] = pesan;
  }
  return keluar;
}

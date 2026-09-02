// RKA, spec 9.3. One page per budget type: entry, the version list, approval,
// and revision.
//
// THE VERSION MODEL IS THE POINT OF THIS SCREEN, so it is shown rather than
// implied. A budget is not one document, it is a numbered series of them, and
// exactly one member of that series is the DISETUJUI baseline every "versus
// anggaran" figure in the product is measured against. A user who cannot see
// which version that is cannot tell what a variance was measured against, so
// the baseline is named in its own panel, marked in the list, and carried into
// the heading of whichever version is open.
//
// A CHANGE MAKES A NEW VERSION, IT NEVER EDITS AN APPROVED ONE. The server
// enforces that (`RKA_SUDAH_DISETUJUI`) and this screen agrees with it rather
// than duplicating it: the grid is editable only on a DRAFT, and the control
// offered on an approved version is "Buat revisi", which opens the NEXT
// version as a draft and leaves the approved one exactly as it is, still the
// baseline, until the new one is approved in its turn.
//
// ENTRY AND APPROVAL ARE TWO DIFFERENT AUTHORITIES. `admin.rka` enters a
// budget and `admin.rka.approve` approves one, and they are separate codes on
// the server for the reason spec 2 separates maker from approver everywhere
// else. This page hides neither behind the other: holding one does not light
// up the other's button. Whether one PERSON may do both is a configuration
// question (`rka.pemisahan_tugas_persetujuan`) the server answers, and when it
// refuses a self approval the refusal is shown verbatim rather than guessed at
// here.
//
// THE GRID IS SAVED WHOLE. `POST /rka/:id/baris` REPLACES the lines, so this
// page keeps every month in state, not just the month on screen, and submits
// all of them. A partial save is how a line nobody meant to keep survives a
// revision.
//
// NOTHING HERE POSTS A JOURNAL. An RKA is a target, not a transaction; the
// module has no ledger port at all.
import { useEffect, useMemo, useState } from "react";
import {
  Bento,
  BentoItem,
  Button,
  DataTable,
  Field,
  Icon,
  Modal,
  MoneyInput,
  Panel,
  Select,
  StatusBadge,
  TextInput,
  Textarea,
  formatCount,
  formatDate,
  formatMoney,
  formatTotal,
  type Column,
} from "@krakatausteel/ui";
import {
  bacaRka,
  baselineRka,
  buatRevisiRka,
  buatRka,
  daftarRka,
  referensiRka,
  setujuiRka,
  simpanBarisRka,
  type BarisRkaInput,
  type JenisRka,
  type ReferensiRka,
  type Rka,
  type RkaLengkap,
} from "../../api/rka";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useRouter } from "../../router";
import { useActiveSession } from "../../session";
import {
  AntreanKosong,
  BarisAksi,
  CatatanOtorisasi,
  HalamanModul,
  hariIni,
  Muat,
  Penyaring,
  useLayarKecil,
} from "../shared/parts";

const NAMA_BULAN = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
] as const;

/** What each budget type files its lines against, in the spec's own words. */
const PROFIL: Record<
  JenisRka,
  { dimensiLabel: string; barisLabel: string; pakaiUnit: boolean; unitLabel: string }
> = {
  PUMK: {
    dimensiLabel: "Sektor",
    barisLabel: "Target penyaluran per sektor",
    pakaiUnit: true,
    unitLabel: "Jumlah mitra target",
  },
  NON_PUMK: {
    dimensiLabel: "Bidang",
    barisLabel: "Anggaran program per bidang",
    pakaiUnit: false,
    unitLabel: "",
  },
  KEUANGAN: {
    dimensiLabel: "Akun",
    barisLabel: "Anggaran beban dan target pendapatan per akun",
    pakaiUnit: false,
    unitLabel: "",
  },
};

const KONSOLIDASI = "KONSOLIDASI";
const TAHUNAN = "TAHUNAN";

/** One editable cell group: a dimension in a month. */
interface BarisEdit {
  uraian: string;
  /** The API's `Uang` string, or "" for a line with no figure. */
  jumlahAnggaran: string;
  /** False when the operator typed something the money grammar could not read.
   *  Not the same as empty, and the submit button stays shut over it. */
  terbaca: boolean;
  jumlahUnit: string;
  keterangan: string;
}

function kunciBaris(dimensiId: string, bulan: number | null): string {
  return `${dimensiId}#${bulan ?? "TAHUNAN"}`;
}

function barisKosong(): BarisEdit {
  return { uraian: "", jumlahAnggaran: "", terbaca: true, jumlahUnit: "", keterangan: "" };
}

export function RkaPage({ route, jenis }: { route: PageRoute; jenis: JenisRka }) {
  const session = useActiveSession();
  const { query, setQuery } = useRouter();
  const kecil = useLayarKecil();

  const bolehUbah = session.permissions.includes("admin.rka");
  const bolehSetujui = session.permissions.includes("admin.rka.approve");

  const tahunUrl = Number(query.get("tahun"));
  const tahun =
    Number.isInteger(tahunUrl) && tahunUrl >= 2000 && tahunUrl <= 2100
      ? tahunUrl
      : session.periode.tahun;

  const referensi = useApi(() => referensiRka(jenis), [jenis]);

  const opsiCabang = referensi.data?.cabang ?? [];
  const bolehKonsolidasi = referensi.data?.bolehKonsolidasi ?? false;
  const cabangUrl = query.get("cabang");
  const lingkup =
    cabangUrl === KONSOLIDASI && bolehKonsolidasi
      ? KONSOLIDASI
      : cabangUrl && opsiCabang.some((c) => c.id === cabangUrl)
        ? cabangUrl
        : bolehKonsolidasi
          ? KONSOLIDASI
          : (opsiCabang[0]?.id ?? null);
  const cabangId = lingkup === KONSOLIDASI ? null : lingkup;

  const daftar = useApi(
    () =>
      daftarRka(
        lingkup === KONSOLIDASI
          ? { tahun, jenis, konsolidasi: true }
          : { tahun, jenis, cabangId },
      ),
    [tahun, jenis, lingkup, cabangId],
    { enabled: referensi.status === "siap" && lingkup !== null },
  );

  const baseline = useApi(
    () => baselineRka({ tahun, jenis, cabangId }),
    [tahun, jenis, cabangId],
    { enabled: referensi.status === "siap" && lingkup !== null },
  );

  const versiList = daftar.data?.data ?? [];
  const rkaUrl = query.get("rka");
  const rkaId =
    rkaUrl && versiList.some((v) => v.id === rkaUrl) ? rkaUrl : (versiList[0]?.id ?? null);

  const detail = useApi(() => bacaRka(rkaId ?? ""), [rkaId], { enabled: rkaId !== null });

  const buat = useAction(buatRka);
  const [buatTerbuka, setBuatTerbuka] = useState(false);
  const [buatKeterangan, setBuatKeterangan] = useState("");

  const namaLingkup =
    lingkup === KONSOLIDASI
      ? "Konsolidasi seluruh entitas"
      : (opsiCabang.find((c) => c.id === lingkup)?.nama ?? "Cabang belum dipilih");

  const tahunOpsi = useMemo(() => {
    const dasar = session.periode.tahun;
    return [dasar + 1, dasar, dasar - 1, dasar - 2];
  }, [session.periode.tahun]);

  const kontrol = (
    <div className="filter-laporan">
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Tahun anggaran</span>
        <Select
          aria-label="Tahun anggaran"
          value={String(tahun)}
          onChange={(event) => {
            setQuery("tahun", event.currentTarget.value);
            setQuery("rka", null);
          }}
          options={tahunOpsi.map((item) => ({ value: String(item), label: String(item) }))}
        />
      </label>
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Lingkup anggaran</span>
        <Select
          aria-label="Lingkup anggaran"
          value={lingkup ?? ""}
          disabled={opsiCabang.length === 0 && !bolehKonsolidasi}
          onChange={(event) => {
            setQuery("cabang", event.currentTarget.value);
            setQuery("rka", null);
          }}
          options={[
            ...(bolehKonsolidasi
              ? [{ value: KONSOLIDASI, label: "Konsolidasi seluruh entitas" }]
              : []),
            ...opsiCabang.map((c) => ({ value: c.id, label: `${c.kode} ${c.nama}` })),
            ...(opsiCabang.length === 0 && !bolehKonsolidasi
              ? [
                  {
                    value: "",
                    label:
                      referensi.status === "memuat" ? "Memuat cabang" : "Tidak ada cabang",
                  },
                ]
              : []),
          ]}
        />
      </label>
    </div>
  );

  return (
    <HalamanModul
      route={route}
      actions={
        bolehUbah ? (
          <Button
            variant="primary"
            onClick={() => setBuatTerbuka(true)}
            disabled={referensi.status !== "siap" || lingkup === null}
            leading={<Icon name="plus" size={16} />}
          >
            Buat RKA baru
          </Button>
        ) : null
      }
    >
      {kecil ? (
        <Penyaring ringkas={`${tahun}, ${namaLingkup}`}>{kontrol}</Penyaring>
      ) : (
        kontrol
      )}

      <Muat hasil={referensi} judul="referensi RKA" sumber="GET /api/rka/referensi">
        {(ref: ReferensiRka) => (
          <>
            <Bento columns={3}>
              <BentoItem span="wide">
                <Panel
                  as="h2"
                  title="Versi anggaran"
                  description={`Setiap perubahan membentuk versi baru. Versi berstatus Disetujui adalah baseline pembanding untuk tahun ${tahun}.`}
                  footer={
                    <span className="panel-foot-note">
                      Sumber: GET /api/rka?tahun={tahun}&amp;jenis={jenis}
                    </span>
                  }
                >
                  <Muat hasil={daftar} judul="daftar versi RKA" sumber="GET /api/rka">
                    {(isi) => (
                      <DaftarVersi
                        versi={isi.data}
                        baselineId={baseline.data?.data?.id ?? null}
                        aktifId={rkaId}
                        onPilih={(id) => setQuery("rka", id)}
                      />
                    )}
                  </Muat>
                </Panel>
              </BentoItem>

              <BentoItem span="sm">
                <Panel
                  as="h2"
                  title="Baseline pembanding"
                  description={`Versi yang berlaku untuk ${namaLingkup} pada tahun ${tahun}.`}
                  footer={
                    <span className="panel-foot-note">Sumber: GET /api/rka/baseline</span>
                  }
                >
                  <Muat hasil={baseline} judul="baseline RKA" sumber="GET /api/rka/baseline">
                    {(isi) => <KartuBaseline rka={isi.data} />}
                  </Muat>
                </Panel>
              </BentoItem>
            </Bento>

            {/* No second empty panel when there is simply no version yet: the
                list above already says so, in the place a reader looks for it,
                and two boxes saying the same thing read as two problems. */}
            {rkaId === null ? null : (
              <Muat hasil={detail} judul="rincian versi RKA" sumber={`GET /api/rka/${rkaId}`}>
                {(rka: RkaLengkap) => (
                  <RincianVersi
                    key={rka.id}
                    rka={rka}
                    ref_={ref}
                    jenis={jenis}
                    bolehUbah={bolehUbah}
                    bolehSetujui={bolehSetujui}
                    baselineId={baseline.data?.data?.id ?? null}
                    onBerubah={(idBaru) => {
                      daftar.reload();
                      baseline.reload();
                      if (idBaru) setQuery("rka", idBaru);
                      else detail.reload();
                    }}
                  />
                )}
              </Muat>
            )}

            <Modal
              open={buatTerbuka}
              title="Buat RKA baru"
              description={`Versi 1 berstatus Draft untuk ${namaLingkup}, tahun ${tahun}, ${route.label}. Barisnya diisi setelah versi terbentuk.`}
              onClose={() => setBuatTerbuka(false)}
              actions={
                <>
                  <Button variant="secondary" onClick={() => setBuatTerbuka(false)}>
                    Batal
                  </Button>
                  <Button
                    variant="primary"
                    loading={buat.status === "mengirim"}
                    onClick={async () => {
                      const hasil = await buat.jalankan({
                        cabangId,
                        tahun,
                        jenis,
                        keterangan: buatKeterangan.trim() === "" ? null : buatKeterangan.trim(),
                        baris: [],
                      });
                      if (hasil) {
                        setBuatTerbuka(false);
                        setBuatKeterangan("");
                        daftar.reload();
                        baseline.reload();
                        setQuery("rka", hasil.id);
                      }
                    }}
                  >
                    Buat versi Draft
                  </Button>
                </>
              }
            >
              <Field label="Keterangan" htmlFor="rka-keterangan" hint="Boleh dikosongkan.">
                <Textarea
                  id="rka-keterangan"
                  rows={3}
                  value={buatKeterangan}
                  maxLength={500}
                  onChange={(event) => setBuatKeterangan(event.currentTarget.value)}
                />
              </Field>
              {buat.status === "gagal" ? (
                <p className="form-error" role="alert">
                  <Icon name="alert" size={16} />
                  <span>{buat.error}</span>
                </p>
              ) : null}
            </Modal>
          </>
        )}
      </Muat>

      <p className="page-note">
        <Icon name="info" size={16} />
        <span>
          RKA adalah target, bukan transaksi. Menyimpan atau menyetujui di halaman ini tidak
          membentuk jurnal apa pun.
        </span>
      </p>
      <CatatanOtorisasi tambahan="Input, persetujuan, dan pembacaan RKA adalah tiga kewenangan terpisah." />
    </HalamanModul>
  );
}

// ---------------------------------------------------------------------------
// The version list
// ---------------------------------------------------------------------------

interface BarisVersi extends Rka {
  baseline: boolean;
}

function DaftarVersi({
  versi,
  baselineId,
  aktifId,
  onPilih,
}: {
  versi: readonly Rka[];
  baselineId: string | null;
  aktifId: string | null;
  onPilih: (id: string) => void;
}) {
  const rows: BarisVersi[] = versi.map((item) => ({ ...item, baseline: item.id === baselineId }));

  const columns: readonly Column<BarisVersi>[] = [
    {
      key: "versi",
      header: "Versi",
      width: "90px",
      render: (row) => <span className="angka">{formatCount(row.versi)}</span>,
    },
    {
      key: "status",
      header: "Status",
      width: "140px",
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: "baseline",
      header: "Baseline",
      width: "130px",
      render: (row) =>
        row.baseline ? (
          <span className="tanda-baseline">
            <Icon name="checkCircle" size={16} />
            <span>Baseline</span>
          </span>
        ) : (
          <span className="angka-kosong">Bukan baseline</span>
        ),
    },
    {
      key: "keterangan",
      header: "Keterangan",
      render: (row) => (
        <span className="sel-ringkas">{row.keterangan ?? "Tidak diisi"}</span>
      ),
    },
    {
      key: "approvedAt",
      header: "Disetujui",
      width: "140px",
      render: (row) =>
        row.approvedAt ? formatDate(row.approvedAt) : <span className="angka-kosong">Belum</span>,
    },
  ];

  if (rows.length === 0) {
    return (
      <AntreanKosong
        icon="calculator"
        title="Belum ada versi RKA"
        description="Belum ada satu versi pun untuk tahun dan lingkup ini, jadi belum ada baris anggaran yang bisa diisi. Versi pertama dibuat dari tombol Buat RKA baru, berstatus Draft, lalu barisnya diisi per bulan."
      />
    );
  }

  return (
    <>
      <div className="daftar-tabel">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          emptyTitle="Belum ada versi RKA"
          onRowClick={(row) => onPilih(row.id)}
        />
      </div>
      <div className="daftar-kartu">
        <ul className="kartu-list">
          {rows.map((row) => (
            <li className="kartu-item" key={row.id}>
              <button
                type="button"
                className={row.id === aktifId ? "kartu-btn is-aktif" : "kartu-btn"}
                onClick={() => onPilih(row.id)}
              >
                <span className="kartu-head">
                  <span className="kartu-judul">Versi {formatCount(row.versi)}</span>
                  <StatusBadge status={row.status} />
                </span>
                <span className="kartu-sub">{row.keterangan ?? "Tanpa keterangan"}</span>
                <span className="kartu-foot">
                  <span className="kartu-meta">
                    {row.baseline ? "Baseline pembanding" : "Bukan baseline"}
                  </span>
                  <span className="kartu-nilai">
                    <span className="kartu-nilai-label">Disetujui</span>
                    <span className="kartu-nilai-val">
                      {row.approvedAt ? formatDate(row.approvedAt) : "Belum"}
                    </span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function KartuBaseline({ rka }: { rka: Rka | null }) {
  if (rka === null) {
    return (
      <div className="baseline-kosong">
        <p className="baseline-judul">Belum ada baseline</p>
        <p className="baseline-teks">
          Belum ada versi berstatus Disetujui untuk tahun dan lingkup ini, jadi Laporan RKA versus
          Realisasi belum punya pembanding dan setiap selisih belum bisa diukur.
        </p>
      </div>
    );
  }
  return (
    <dl className="baseline-fakta">
      <div className="baseline-baris">
        <dt>Versi</dt>
        <dd>
          <span className="angka">{formatCount(rka.versi)}</span>
        </dd>
      </div>
      <div className="baseline-baris">
        <dt>Status</dt>
        <dd>
          <StatusBadge status={rka.status} />
        </dd>
      </div>
      <div className="baseline-baris">
        <dt>Tanggal disetujui</dt>
        <dd>{rka.approvedAt ? formatDate(rka.approvedAt) : "Belum diisi"}</dd>
      </div>
      <div className="baseline-baris">
        <dt>Disetujui oleh (ID pengguna)</dt>
        <dd>
          <span className="baseline-id">{rka.approvedBy ?? "Belum diisi"}</span>
        </dd>
      </div>
      <div className="baseline-baris">
        <dt>Versi sebelumnya</dt>
        <dd>
          {rka.versiSebelumnya === null ? (
            "Tidak ada, ini versi pertama"
          ) : (
            <span className="angka">{formatCount(rka.versiSebelumnya)}</span>
          )}
        </dd>
      </div>
    </dl>
  );
}

// ---------------------------------------------------------------------------
// One version: the grid, and what may be done to it
// ---------------------------------------------------------------------------

function RincianVersi({
  rka,
  ref_,
  jenis,
  bolehUbah,
  bolehSetujui,
  baselineId,
  onBerubah,
}: {
  rka: RkaLengkap;
  ref_: ReferensiRka;
  jenis: JenisRka;
  bolehUbah: boolean;
  bolehSetujui: boolean;
  baselineId: string | null;
  onBerubah: (idBaru: string | null) => void;
}) {
  const profil = PROFIL[jenis];
  const draft = rka.status === "DRAFT";
  const dapatDiubah = draft && bolehUbah;

  const [bulanPilihan, setBulanPilihan] = useState<string>(
    String(ref_.tahunBukuMulaiBulan || 1),
  );
  const bulan = bulanPilihan === TAHUNAN ? null : Number(bulanPilihan);

  const [cari, setCari] = useState("");
  const [grid, setGrid] = useState<Record<string, BarisEdit>>(() => gridDari(rka, ref_));

  // A different version, or the same one re-read after a save: the grid is
  // rebuilt from the server's answer rather than merged into what was on
  // screen, because a merge is how an edit survives a revision that dropped it.
  useEffect(() => {
    setGrid(gridDari(rka, ref_));
  }, [rka, ref_]);

  const simpan = useAction((input: { rkaId: string; baris: BarisRkaInput[] }) =>
    simpanBarisRka(input.rkaId, input.baris),
  );
  const setujui = useAction(setujuiRka);
  const revisi = useAction(buatRevisiRka);

  const [setujuiTerbuka, setSetujuiTerbuka] = useState(false);
  const [tanggalSetujui, setTanggalSetujui] = useState(hariIni());
  const [catatanSetujui, setCatatanSetujui] = useState("");
  const [revisiTerbuka, setRevisiTerbuka] = useState(false);
  const [revisiKeterangan, setRevisiKeterangan] = useState("");
  const [salinBaris, setSalinBaris] = useState(true);

  const opsiTampil = useMemo(() => {
    const kata = cari.trim().toLowerCase();
    const cocok = ref_.opsi.filter(
      (opsi) =>
        kata === "" ||
        opsi.kode.toLowerCase().includes(kata) ||
        opsi.nama.toLowerCase().includes(kata),
    );
    // A version nobody may edit shows only the lines it actually has: a read
    // only page listing two hundred empty accounts hides the twelve that carry
    // a figure.
    if (dapatDiubah) return cocok;
    return cocok.filter((opsi) => {
      const isi = grid[kunciBaris(opsi.id, bulan)];
      return isi !== undefined && isi.jumlahAnggaran !== "";
    });
  }, [ref_.opsi, cari, dapatDiubah, grid, bulan]);

  const adaTidakTerbaca = Object.values(grid).some((baris) => !baris.terbaca);
  const nilaiTerisi = Object.values(grid).filter((baris) => baris.jumlahAnggaran !== "");
  const totalGrid = formatTotal(nilaiTerisi.map((baris) => baris.jumlahAnggaran));

  function ubah(dimensiId: string, patch: Partial<BarisEdit>) {
    const kunci = kunciBaris(dimensiId, bulan);
    setGrid((sebelum) => ({
      ...sebelum,
      [kunci]: { ...(sebelum[kunci] ?? barisKosong()), ...patch },
    }));
  }

  function bacaBaris(dimensiId: string): BarisEdit {
    return grid[kunciBaris(dimensiId, bulan)] ?? barisKosong();
  }

  async function kirimGrid() {
    const baris: BarisRkaInput[] = [];
    for (const [kunci, isi] of Object.entries(grid)) {
      if (isi.jumlahAnggaran === "") continue;
      const [dimensiId = "", bagianBulan = TAHUNAN] = kunci.split("#");
      const nama = ref_.opsi.find((opsi) => opsi.id === dimensiId)?.nama ?? "";
      const unit = isi.jumlahUnit.trim();
      baris.push({
        ...(ref_.dimensi === "AKUN" ? { akunId: dimensiId } : {}),
        ...(ref_.dimensi === "SEKTOR" ? { sektorId: dimensiId } : {}),
        ...(ref_.dimensi === "BIDANG" ? { bidangId: dimensiId } : {}),
        uraian: isi.uraian.trim() === "" ? nama : isi.uraian.trim(),
        bulan: bagianBulan === TAHUNAN ? null : Number(bagianBulan),
        jumlahAnggaran: isi.jumlahAnggaran,
        jumlahUnit: unit === "" ? null : Number(unit),
        keterangan: isi.keterangan.trim() === "" ? null : isi.keterangan.trim(),
      });
    }
    const hasil = await simpan.jalankan({ rkaId: rka.id, baris });
    if (hasil) onBerubah(null);
  }

  const kolomGrid: readonly Column<{ id: string; kode: string; nama: string }>[] = [
    {
      key: "kode",
      header: profil.dimensiLabel,
      width: "220px",
      render: (opsi) => (
        <span className="sel-utama">
          <span className="sel-utama-judul">{opsi.kode}</span>
          <span className="sel-utama-sub">{opsi.nama}</span>
        </span>
      ),
    },
    {
      key: "uraian",
      header: "Uraian",
      render: (opsi) =>
        dapatDiubah ? (
          <TextInput
            aria-label={`Uraian ${opsi.nama}`}
            value={bacaBaris(opsi.id).uraian}
            maxLength={300}
            placeholder={opsi.nama}
            onChange={(event) => ubah(opsi.id, { uraian: event.currentTarget.value })}
          />
        ) : (
          <span className="sel-ringkas">{bacaBaris(opsi.id).uraian || opsi.nama}</span>
        ),
    },
    {
      key: "jumlahAnggaran",
      header: "Anggaran",
      type: "money",
      width: "210px",
      render: (opsi) => {
        const isi = bacaBaris(opsi.id);
        return dapatDiubah ? (
          <MoneyInput
            aria-label={`Anggaran ${opsi.nama}`}
            value={isi.jumlahAnggaran}
            invalid={!isi.terbaca}
            onValueChange={(nilai, mentah) =>
              ubah(opsi.id, {
                jumlahAnggaran: nilai ?? "",
                terbaca: mentah.trim() === "" || nilai !== null,
              })
            }
          />
        ) : (
          <span className="angka">{formatMoney(isi.jumlahAnggaran || "0.00")}</span>
        );
      },
    },
    ...(profil.pakaiUnit
      ? [
          {
            key: "jumlahUnit",
            header: profil.unitLabel,
            type: "count" as const,
            width: "170px",
            render: (opsi: { id: string; kode: string; nama: string }) => {
              const isi = bacaBaris(opsi.id);
              return dapatDiubah ? (
                <TextInput
                  aria-label={`${profil.unitLabel} ${opsi.nama}`}
                  inputMode="numeric"
                  value={isi.jumlahUnit}
                  onChange={(event) =>
                    ubah(opsi.id, {
                      jumlahUnit: event.currentTarget.value.replace(/[^0-9]/g, ""),
                    })
                  }
                />
              ) : isi.jumlahUnit === "" ? (
                <span className="angka-kosong">Tidak ditargetkan</span>
              ) : (
                <span className="angka">{formatCount(isi.jumlahUnit)}</span>
              );
            },
          },
        ]
      : []),
  ];

  return (
    <>
      <Panel
        as="h2"
        title={`Versi ${formatCount(rka.versi)}`}
        description={rka.keterangan ?? "Tanpa keterangan."}
        aside={
          <span className="versi-tanda">
            <StatusBadge status={rka.status} />
            {rka.id === baselineId ? (
              <span className="tanda-baseline">
                <Icon name="checkCircle" size={16} />
                <span>Baseline</span>
              </span>
            ) : null}
          </span>
        }
      >
        <dl className="versi-fakta">
          <div className="versi-baris">
            <dt>Total anggaran versi ini</dt>
            <dd>
              <span className="angka">{formatMoney(rka.totalAnggaran)}</span>
            </dd>
          </div>
          <div className="versi-baris">
            <dt>Jumlah baris</dt>
            <dd>
              <span className="angka">{formatCount(rka.baris.length)}</span>
            </dd>
          </div>
          <div className="versi-baris">
            <dt>Versi sebelumnya</dt>
            <dd>
              {rka.versiSebelumnya === null ? (
                "Tidak ada, ini versi pertama"
              ) : (
                <span className="angka">{formatCount(rka.versiSebelumnya)}</span>
              )}
            </dd>
          </div>
          <div className="versi-baris">
            <dt>Tanggal disetujui</dt>
            <dd>{rka.approvedAt ? formatDate(rka.approvedAt) : "Belum disetujui"}</dd>
          </div>
        </dl>

        {!draft ? (
          <p className="page-note">
            <Icon name="lock" size={16} />
            <span>
              Versi ini sudah keluar dari status Draft, jadi barisnya tidak bisa diubah lagi.
              Perubahan anggaran dilakukan dengan membuat revisi, yang membentuk versi berikutnya
              dan meninggalkan versi ini apa adanya.
            </span>
          </p>
        ) : null}
      </Panel>

      <Panel
        as="h2"
        title={profil.barisLabel}
        description={
          bulan === null
            ? "Angka tahunan tanpa rincian bulan."
            : `Bulan ${NAMA_BULAN[bulan - 1]}. Tahun buku dimulai pada bulan ${NAMA_BULAN[(ref_.tahunBukuMulaiBulan || 1) - 1]}.`
        }
        footer={
          dapatDiubah ? (
            <BarisAksi
              error={
                adaTidakTerbaca
                  ? "Ada nilai anggaran yang tidak terbaca sebagai angka. Perbaiki dulu sebelum menyimpan, karena mengirimkan 0,00 untuk angka yang gagal dibaca akan mengubah anggaran tanpa disadari."
                  : simpan.status === "gagal"
                    ? simpan.error
                    : null
              }
              primary={
                <Button
                  variant="primary"
                  loading={simpan.status === "mengirim"}
                  disabled={adaTidakTerbaca}
                  onClick={kirimGrid}
                >
                  Simpan seluruh baris
                </Button>
              }
              secondary={
                bolehSetujui ? (
                  <Button variant="secondary" onClick={() => setSetujuiTerbuka(true)}>
                    Setujui versi ini
                  </Button>
                ) : null
              }
            />
          ) : rka.status === "DISETUJUI" && bolehUbah ? (
            <BarisAksi
              error={revisi.status === "gagal" ? revisi.error : null}
              primary={
                <Button variant="primary" onClick={() => setRevisiTerbuka(true)}>
                  Buat revisi
                </Button>
              }
            />
          ) : null
        }
      >
        <div className="grid-kontrol">
          <label className="filter-laporan-group">
            <span className="filter-laporan-label">Bulan</span>
            <Select
              aria-label="Bulan anggaran"
              value={bulanPilihan}
              onChange={(event) => setBulanPilihan(event.currentTarget.value)}
              options={[
                ...urutBulan(ref_.tahunBukuMulaiBulan).map((nomor) => ({
                  value: String(nomor),
                  label: NAMA_BULAN[nomor - 1] ?? String(nomor),
                })),
                { value: TAHUNAN, label: "Tahunan, tanpa rincian bulan" },
              ]}
            />
          </label>
          <label className="filter-laporan-group is-grow">
            <span className="filter-laporan-label">Cari {profil.dimensiLabel.toLowerCase()}</span>
            <TextInput
              aria-label={`Cari ${profil.dimensiLabel}`}
              value={cari}
              placeholder="Kode atau nama"
              onChange={(event) => setCari(event.currentTarget.value)}
            />
          </label>
          <span className="grid-total">
            <span className="grid-total-label">Total seluruh bulan yang terisi</span>
            <span className="grid-total-val angka">{totalGrid}</span>
          </span>
        </div>

        {opsiTampil.length === 0 ? (
          <AntreanKosong
            icon="list"
            title={dapatDiubah ? `Tidak ada ${profil.dimensiLabel.toLowerCase()} yang cocok` : "Tidak ada baris pada bulan ini"}
            description={
              dapatDiubah
                ? `Ubah kata pencarian, atau lengkapi master ${profil.dimensiLabel.toLowerCase()} terlebih dahulu.`
                : "Versi ini tidak punya baris anggaran pada bulan yang dipilih."
            }
          />
        ) : (
          <>
            {/* A budget grid is a desk instrument: four columns of inputs at a
                monitor, and the SAME rows as one card per dimension on a
                phone. Both are driven by `opsiTampil` and both write into the
                same `grid` state, so the two shapes cannot disagree about what
                was typed. */}
            <div className="daftar-tabel grid-rka">
              <DataTable
                columns={kolomGrid}
                rows={opsiTampil}
                rowKey={(opsi) => opsi.id}
                emptyTitle="Tidak ada baris"
                stickyHeader={false}
              />
            </div>
            <div className="daftar-kartu">
              <ul className="kartu-list">
                {opsiTampil.map((opsi) => {
                  const isi = bacaBaris(opsi.id);
                  return (
                    <li className="kartu-item is-statis" key={opsi.id}>
                      <div className="anggaran-kartu">
                        <p className="kartu-judul">
                          {opsi.kode} {opsi.nama}
                        </p>
                        {dapatDiubah ? (
                          <>
                            <Field
                              label="Uraian"
                              htmlFor={`uraian-${opsi.id}`}
                              hint={`Kosong berarti "${opsi.nama}".`}
                            >
                              <TextInput
                                id={`uraian-${opsi.id}`}
                                value={isi.uraian}
                                maxLength={300}
                                placeholder={opsi.nama}
                                onChange={(event) =>
                                  ubah(opsi.id, { uraian: event.currentTarget.value })
                                }
                              />
                            </Field>
                            <Field
                              label="Anggaran"
                              htmlFor={`anggaran-${opsi.id}`}
                              error={
                                isi.terbaca
                                  ? undefined
                                  : "Tidak terbaca sebagai angka rupiah."
                              }
                            >
                              <MoneyInput
                                id={`anggaran-${opsi.id}`}
                                value={isi.jumlahAnggaran}
                                invalid={!isi.terbaca}
                                onValueChange={(nilai, mentah) =>
                                  ubah(opsi.id, {
                                    jumlahAnggaran: nilai ?? "",
                                    terbaca: mentah.trim() === "" || nilai !== null,
                                  })
                                }
                              />
                            </Field>
                            {profil.pakaiUnit ? (
                              <Field label={profil.unitLabel} htmlFor={`unit-${opsi.id}`}>
                                <TextInput
                                  id={`unit-${opsi.id}`}
                                  inputMode="numeric"
                                  value={isi.jumlahUnit}
                                  onChange={(event) =>
                                    ubah(opsi.id, {
                                      jumlahUnit: event.currentTarget.value.replace(
                                        /[^0-9]/g,
                                        "",
                                      ),
                                    })
                                  }
                                />
                              </Field>
                            ) : null}
                          </>
                        ) : (
                          <dl className="varian-grid">
                            <div className="varian-sel">
                              <dt>Uraian</dt>
                              <dd>{isi.uraian || opsi.nama}</dd>
                            </div>
                            <div className="varian-sel">
                              <dt>Anggaran</dt>
                              <dd>
                                <span className="angka">
                                  {formatMoney(isi.jumlahAnggaran || "0.00")}
                                </span>
                              </dd>
                            </div>
                            {profil.pakaiUnit ? (
                              <div className="varian-sel">
                                <dt>{profil.unitLabel}</dt>
                                <dd>
                                  {isi.jumlahUnit === "" ? (
                                    <span className="angka-kosong">Tidak ditargetkan</span>
                                  ) : (
                                    <span className="angka">{formatCount(isi.jumlahUnit)}</span>
                                  )}
                                </dd>
                              </div>
                            ) : null}
                          </dl>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </>
        )}

        {!bolehUbah ? (
          <p className="page-note">
            <Icon name="lock" size={16} />
            <span>
              Anda dapat membaca RKA ini tetapi tidak mengubahnya. Kewenangan input RKA
              (admin.rka) terpisah dari kewenangan membaca (admin.rka.view).
            </span>
          </p>
        ) : null}
      </Panel>

      <Modal
        open={setujuiTerbuka}
        title={`Setujui versi ${rka.versi}`}
        description="Versi ini menjadi baseline pembanding, dan baseline yang lama berubah menjadi Revisi. Tidak ada jurnal yang terbentuk."
        onClose={() => setSetujuiTerbuka(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setSetujuiTerbuka(false)}>
              Batal
            </Button>
            <Button
              variant="primary"
              loading={setujui.status === "mengirim"}
              onClick={async () => {
                const hasil = await setujui.jalankan({
                  rkaId: rka.id,
                  tanggal: tanggalSetujui === "" ? null : tanggalSetujui,
                  catatan: catatanSetujui.trim() === "" ? null : catatanSetujui.trim(),
                });
                if (hasil) {
                  setSetujuiTerbuka(false);
                  onBerubah(null);
                }
              }}
            >
              Setujui
            </Button>
          </>
        }
      >
        <Field label="Tanggal persetujuan" htmlFor="rka-tanggal-setujui">
          <TextInput
            id="rka-tanggal-setujui"
            type="date"
            value={tanggalSetujui}
            onChange={(event) => setTanggalSetujui(event.currentTarget.value)}
          />
        </Field>
        <Field label="Catatan persetujuan" htmlFor="rka-catatan-setujui" hint="Boleh dikosongkan.">
          <Textarea
            id="rka-catatan-setujui"
            rows={3}
            maxLength={500}
            value={catatanSetujui}
            onChange={(event) => setCatatanSetujui(event.currentTarget.value)}
          />
        </Field>
        {setujui.status === "gagal" ? (
          <p className="form-error" role="alert">
            <Icon name="alert" size={16} />
            <span>{setujui.error}</span>
          </p>
        ) : null}
      </Modal>

      <Modal
        open={revisiTerbuka}
        title={`Buat revisi dari versi ${rka.versi}`}
        description="Revisi membentuk versi berikutnya berstatus Draft. Versi yang sekarang tetap berstatus Disetujui dan tetap menjadi baseline sampai revisinya disetujui."
        onClose={() => setRevisiTerbuka(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setRevisiTerbuka(false)}>
              Batal
            </Button>
            <Button
              variant="primary"
              loading={revisi.status === "mengirim"}
              onClick={async () => {
                const hasil = await revisi.jalankan({
                  rkaId: rka.id,
                  keterangan: revisiKeterangan.trim() === "" ? null : revisiKeterangan.trim(),
                  salinBaris,
                });
                if (hasil) {
                  setRevisiTerbuka(false);
                  setRevisiKeterangan("");
                  onBerubah(hasil.id);
                }
              }}
            >
              Buat revisi
            </Button>
          </>
        }
      >
        <Field label="Keterangan revisi" htmlFor="rka-keterangan-revisi" hint="Boleh dikosongkan.">
          <Textarea
            id="rka-keterangan-revisi"
            rows={3}
            maxLength={500}
            value={revisiKeterangan}
            onChange={(event) => setRevisiKeterangan(event.currentTarget.value)}
          />
        </Field>
        <label className="filter-laporan-check">
          <input
            type="checkbox"
            checked={salinBaris}
            onChange={(event) => setSalinBaris(event.currentTarget.checked)}
          />
          <span>Salin seluruh baris versi ini ke versi baru</span>
        </label>
        {revisi.status === "gagal" ? (
          <p className="form-error" role="alert">
            <Icon name="alert" size={16} />
            <span>{revisi.error}</span>
          </p>
        ) : null}
      </Modal>
    </>
  );
}

/** Months of the financial year in order, starting at the configured month. */
function urutBulan(mulai: number): number[] {
  const awal = mulai >= 1 && mulai <= 12 ? mulai : 1;
  return Array.from({ length: 12 }, (_, index) => ((awal - 1 + index) % 12) + 1);
}

/** The server's lines, indexed by dimension and month, ready to edit. */
function gridDari(rka: RkaLengkap, ref_: ReferensiRka): Record<string, BarisEdit> {
  const keluar: Record<string, BarisEdit> = {};
  for (const baris of rka.baris) {
    const dimensiId =
      ref_.dimensi === "AKUN"
        ? baris.akunId
        : ref_.dimensi === "SEKTOR"
          ? baris.sektorId
          : baris.bidangId;
    if (!dimensiId) continue;
    keluar[kunciBaris(dimensiId, baris.bulan)] = {
      uraian: baris.uraian,
      jumlahAnggaran: baris.jumlahAnggaran,
      terbaca: true,
      jumlahUnit: baris.jumlahUnit === null ? "" : String(baris.jumlahUnit),
      keterangan: baris.keterangan ?? "",
    };
  }
  return keluar;
}

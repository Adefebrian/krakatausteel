// Daftar Jurnal, spec 9.4. Every document in the ledger with its status, from
// DRAFT through POSTED to REVERSED, and one document opened underneath.
//
// IT IS ONE LIST UNDER A FILTER, AND THAT IS DELIBERATE. The Checker's queue,
// the Approver's posting queue and the reversal picker are this same
// `GET /jurnal` narrowed by `status`. Three endpoints answering the same rows
// would eventually disagree about what is in the ledger, so the three screens
// that follow this one narrow the same read instead of asking a different one.
//
// A REVERSED DOCUMENT IS NOT MISSING FROM THIS LIST, and must never be. ADR
// 0010: the original stays, marked REVERSED, and `v_ledger_baris` counts both
// halves of the pair. A list that hid it would hide the very row an auditor
// opens to check that a correction was a correction.
//
// THE OPENED DOCUMENT LIVES IN THE QUERY STRING (`?dokumen=`), so a document a
// colleague is asked to look at opens on the same document when the link is
// pasted, and survives a refresh.
import {
  Bento,
  BentoItem,
  Button,
  Icon,
  Panel,
  SearchInput,
  Select,
  TextInput,
  formatCount,
  formatTotal,
} from "@krakatausteel/ui";
import { useState } from "react";
import {
  daftarJurnal,
  detailJurnal,
  JENIS_JURNAL_FILTER,
  type RingkasanJurnal,
} from "../../api/jurnal";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import {
  CatatanOtorisasi,
  HalamanModul,
  Muat,
  Penyaring,
  useLayarKecil,
  useLingkupCabang,
  usePilihan,
} from "../shared/parts";
import { KartuRingkas } from "../tools/parts";
import {
  CatatanBatas,
  DaftarJurnalTabel,
  DokumenJurnal,
  labelJenis,
  labelPeriode,
  usePeriode,
} from "./parts";

const OPSI_STATUS = [
  { value: "", label: "Semua status" },
  { value: "DRAFT", label: "Draft" },
  { value: "POSTED", label: "Posted" },
  { value: "REVERSED", label: "Dibalik" },
];

const OPSI_ASAL = [
  { value: "", label: "Manual dan otomatis" },
  { value: "false", label: "Diinput orang" },
  { value: "true", label: "Dibentuk engine" },
];

export function DaftarJurnal({ route }: { route: PageRoute }) {
  const kecil = useLayarKecil();
  const lingkup = useLingkupCabang("Cabang");
  const [dokumenId, setDokumenId] = usePilihan("dokumen");
  const periode = usePeriode();

  const [periodeId, setPeriodeId] = useState("");
  const [jenis, setJenis] = useState("");
  const [status, setStatus] = useState("");
  const [asal, setAsal] = useState("");
  const [dari, setDari] = useState("");
  const [sampai, setSampai] = useState("");
  const [cari, setCari] = useState("");

  const daftar = useApi(
    () =>
      daftarJurnal({
        periodeId: periodeId || null,
        cabangId: lingkup.cabangId,
        jenis: jenis || null,
        status: (status || null) as never,
        cari: cari.trim() || null,
        dariTanggal: dari || null,
        sampaiTanggal: sampai || null,
        otomatis: asal === "" ? null : asal === "true",
      }),
    [periodeId, lingkup.cabangId, jenis, status, cari, dari, sampai, asal],
  );

  const dokumen = useApi(() => detailJurnal(dokumenId ?? ""), [dokumenId], {
    enabled: dokumenId !== null,
  });

  const ringkasFilter = [
    lingkup.ringkas,
    status === "" ? "semua status" : (OPSI_STATUS.find((o) => o.value === status)?.label ?? status),
    jenis === "" ? "semua jenis" : labelJenis(jenis),
  ].join(" . ");

  const isiFilter = (
    <div className="filter-laporan">
      {lingkup.kontrol}
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Periode</span>
        <Select
          aria-label="Periode akuntansi"
          value={periodeId}
          onChange={(event) => setPeriodeId(event.currentTarget.value)}
          options={[
            { value: "", label: "Semua periode" },
            ...(periode.data?.data ?? []).map((item) => ({
              value: item.id,
              label: labelPeriode(item),
            })),
          ]}
        />
      </label>
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Jenis jurnal</span>
        <Select
          aria-label="Jenis jurnal"
          value={jenis}
          onChange={(event) => setJenis(event.currentTarget.value)}
          options={[
            { value: "", label: "Semua jenis" },
            ...JENIS_JURNAL_FILTER.map((value) => ({ value, label: labelJenis(value) })),
          ]}
        />
      </label>
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Status</span>
        <Select
          aria-label="Status dokumen"
          value={status}
          onChange={(event) => setStatus(event.currentTarget.value)}
          options={OPSI_STATUS}
        />
      </label>
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Asal dokumen</span>
        <Select
          aria-label="Asal dokumen"
          value={asal}
          onChange={(event) => setAsal(event.currentTarget.value)}
          options={OPSI_ASAL}
        />
      </label>
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Dari tanggal</span>
        <TextInput
          type="date"
          aria-label="Dari tanggal transaksi"
          value={dari}
          onChange={(event) => setDari(event.currentTarget.value)}
        />
      </label>
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Sampai tanggal</span>
        <TextInput
          type="date"
          aria-label="Sampai tanggal transaksi"
          value={sampai}
          onChange={(event) => setSampai(event.currentTarget.value)}
        />
      </label>
      <label className="filter-laporan-group is-lebar">
        <span className="filter-laporan-label">Cari nomor atau keterangan</span>
        <SearchInput
          label="Cari nomor jurnal atau keterangan"
          value={cari}
          onChange={(event) => setCari(event.currentTarget.value)}
        />
      </label>
    </div>
  );

  return (
    <HalamanModul route={route}>
      {kecil ? <Penyaring ringkas={ringkasFilter}>{isiFilter}</Penyaring> : isiFilter}

      <Muat hasil={daftar} judul="daftar jurnal" sumber="GET /api/jurnal">
        {(data) => (
          <>
            <BandDokumen rows={data.data} />
            <Panel
              as="h2"
              title="Dokumen jurnal"
              description="Urut mundur berdasarkan tanggal transaksi. Pilih satu baris untuk membuka isinya."
              footer={
                <span className="panel-foot-note">
                  Sumber: GET /api/jurnal. Kewenangan jurnal.view, yang tidak memberi hak mengubah
                  apa pun.
                </span>
              }
            >
              <DaftarJurnalTabel
                rows={data.data}
                onPilih={(row) => setDokumenId(row.id)}
                emptyTitle="Tidak ada dokumen pada filter ini"
                emptyDescription="Longgarkan filter periode, cabang, jenis, atau status untuk melihat dokumen lain."
                caption="Daftar dokumen jurnal"
              />
            </Panel>
            <CatatanBatas jumlah={data.data.length} />
          </>
        )}
      </Muat>

      {dokumenId === null ? null : (
        <Muat hasil={dokumen} judul="isi dokumen" sumber={`GET /api/jurnal/${dokumenId}`}>
          {(isi) => (
            <DokumenJurnal
              jurnal={isi}
              aksi={
                <Button
                  variant="ghost"
                  leading={<Icon name="close" size={16} />}
                  onClick={() => setDokumenId(null)}
                >
                  Tutup dokumen
                </Button>
              }
            />
          )}
        </Muat>
      )}

      <CatatanKoreksi />
      <CatatanOtorisasi tambahan="Halaman ini memerlukan kewenangan jurnal.view." />
    </HalamanModul>
  );
}

/**
 * The headline band. Four cards, one shape, and every figure is a count or a
 * total of what is ON SCREEN, said in those words: a figure over a filtered
 * list that read as "the ledger" would be a wrong number nobody could catch.
 */
function BandDokumen({ rows }: { rows: readonly RingkasanJurnal[] }) {
  const draft = rows.filter((row) => row.status === "DRAFT");
  const posted = rows.filter((row) => row.status === "POSTED");
  const dibalik = rows.filter((row) => row.status === "REVERSED");
  return (
    <Bento columns={4}>
      <BentoItem span="sm">
        <KartuRingkas
          judul="Dokumen tampil"
          nilai={formatCount(rows.length)}
          catatan="Jumlah dokumen pada filter yang sedang aktif, bukan jumlah dokumen di seluruh buku besar."
        />
      </BentoItem>
      <BentoItem span="sm">
        <KartuRingkas
          judul="Total debit tampil"
          nilai={formatTotal(rows.map((row) => row.totalDebit))}
          catatan="Penjumlahan total debit dokumen yang tampil. Draft ikut terhitung dan belum masuk buku besar."
        />
      </BentoItem>
      <BentoItem span="sm">
        <KartuRingkas
          judul="Masih draft"
          nilai={formatCount(draft.length)}
          catatan={`${formatCount(draft.filter((row) => row.verifiedAt !== null).length)} di antaranya sudah diverifikasi Checker dan menunggu posting.`}
        />
      </BentoItem>
      <BentoItem span="sm">
        <KartuRingkas
          judul="Posted dan dibalik"
          nilai={`${formatCount(posted.length)} dan ${formatCount(dibalik.length)}`}
          catatan="Dokumen yang dibalik tetap ada di buku besar, dihitung bersama pasangan pembaliknya."
        />
      </BentoItem>
    </Bento>
  );
}

function CatatanKoreksi() {
  return (
    <p className="page-note">
      <Icon name="info" size={16} />
      <span>
        Tidak ada tombol hapus untuk dokumen POSTED di halaman ini, dan memang tidak ada jalurnya di
        server. Dokumen yang sudah masuk buku besar dikoreksi dengan membentuk jurnal pembalik di
        halaman Hapus Jurnal Transaksi, sehingga dokumen asal tetap tercatat.
      </span>
    </p>
  );
}

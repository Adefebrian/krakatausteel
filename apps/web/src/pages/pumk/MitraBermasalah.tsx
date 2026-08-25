// Pengaturan Mitra Bermasalah, spec 9.1.
//
// The list is the akad whose kolektibilitas is Diragukan or Macet, and the
// point of the page is the FOLLOW-UP TRAIL: every visit, call, warning letter
// and somasi, with its result, so the next officer picks up where the last one
// stopped instead of starting the conversation again.
//
// Kolektibilitas is not decided here. It is set by the monthly closing from
// the arrears ranges in Parameter Sistem, and this page only reads it.
import { useState } from "react";
import {
  Bento,
  BentoItem,
  Button,
  DataList,
  DataTable,
  Field,
  Panel,
  Select,
  Stat,
  StatusBadge,
  Tabs,
  TabPanel,
  Textarea,
  TextInput,
  formatCount,
  formatMoney,
  formatTotal,
  type Column,
} from "@krakatausteel/ui";
import {
  catatTindakLanjut,
  daftarAkad,
  daftarTindakLanjut,
  type BarisAkad,
  type JenisTindakLanjut,
  type TindakLanjut,
} from "../../api/pumk";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { hasPermission } from "../../permissions";
import { useRouter } from "../../router";
import { useActiveSession } from "../../session";
import {
  AntreanKosong,
  Bagian,
  BarisAksi,
  CatatanOtorisasi,
  type ColumnSpec,
  DaftarDokumen,
  FieldGrid,
  HalamanModul,
  hariIni,
  Kolektibilitas,
  Muat,
  RingkasDokumen,
  usePilihan,
} from "../shared/parts";

const JENIS: Array<{ value: JenisTindakLanjut; label: string }> = [
  { value: "KUNJUNGAN", label: "Kunjungan" },
  { value: "TELEPON", label: "Telepon" },
  { value: "SURAT_PERINGATAN", label: "Surat peringatan" },
  { value: "SOMASI", label: "Somasi" },
];

const AKAD_COLUMNS: readonly ColumnSpec<BarisAkad>[] = [
  { key: "noAkad", header: "No Akad", sortable: true, width: "150px" },
  {
    key: "mitraNama",
    header: "Mitra Binaan",
    sortable: true,
    render: (row) => (
      <span className="sel-utama">
        <span className="sel-utama-judul">{row.mitraNama}</span>
        <span className="sel-utama-sub">{row.mitraKode}</span>
      </span>
    ),
  },
  { key: "outstandingPokok", header: "Outstanding pokok", type: "money", sortable: true, width: "170px" },
  { key: "hariTunggakan", header: "Hari tunggakan", type: "count", sortable: true, width: "150px" },
  {
    key: "kolektibilitas",
    header: "Kolektibilitas",
    sortable: true,
    width: "160px",
    render: (row) => <Kolektibilitas kelas={row.kolektibilitas} />,
  },
];

const TINDAK_COLUMNS: readonly Column<TindakLanjut>[] = [
  { key: "tanggal", header: "Tanggal", type: "date", sortable: true, width: "120px" },
  { key: "jenis", header: "Jenis", width: "170px", render: (row) => <StatusBadge status={row.jenis} /> },
  { key: "hasil", header: "Hasil", render: (row) => row.hasil ?? "Belum dicatat" },
  { key: "catatan", header: "Catatan", render: (row) => row.catatan ?? "Tidak ada catatan" },
];

export function MitraBermasalah({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const { navigate } = useRouter();
  const [akadId, setAkadId] = usePilihan("akad");
  const [kelas, setKelas] = useState("DIRAGUKAN");

  const daftar = useApi(
    () => daftarAkad({ cabangId: session.cabang.id, kolektibilitas: kelas }),
    [session.cabang.id, kelas],
    { enabled: akadId === null },
  );
  const trail = useApi(() => daftarTindakLanjut(akadId ?? ""), [akadId], {
    enabled: akadId !== null,
  });

  const [tanggal, setTanggal] = useState(hariIni());
  const [jenis, setJenis] = useState<JenisTindakLanjut>("KUNJUNGAN");
  const [hasilTindak, setHasilTindak] = useState("");
  const [catatan, setCatatan] = useState("");
  const simpan = useAction(catatTindakLanjut);

  const bolehCatat = hasPermission(session.permissions, "pumk.penagihan");

  async function tambah(event: React.FormEvent) {
    event.preventDefault();
    if (!akadId || hasilTindak.trim() === "") return;
    const jawaban = await simpan.jalankan({
      akadId,
      tanggal,
      jenis,
      hasil: hasilTindak.trim(),
      catatan: catatan.trim() || null,
    });
    if (jawaban) {
      setHasilTindak("");
      setCatatan("");
      trail.reload();
    }
  }

  if (akadId === null) {
    const rows = daftar.data?.data ?? [];
    return (
      <HalamanModul route={route}>
        <Tabs
          label="Klasifikasi kolektibilitas"
          active={kelas}
          onChange={setKelas}
          items={[
            { id: "DIRAGUKAN", label: "Diragukan" },
            { id: "MACET", label: "Macet" },
          ]}
          aside={
            <span className="tabs-note">
              Total outstanding {formatTotal(rows.map((row) => row.outstandingPokok))}
            </span>
          }
        />
        <TabPanel id={kelas}>
          <Muat
            hasil={daftar}
            judul="daftar akad bermasalah"
            sumber={`GET /api/pumk/akad?kolektibilitas=${kelas}`}
          >
            {(data) =>
              data.data.length === 0 ? (
                <AntreanKosong
                  icon="checkCircle"
                  title={`Tidak ada akad berklasifikasi ${kelas === "MACET" ? "Macet" : "Diragukan"}`}
                  description="Klasifikasi ditetapkan pada closing kolektibilitas setiap periode, bukan dihitung di halaman ini."
                />
              ) : (
                <Panel
                  as="h2"
                  title={`Akad ${kelas === "MACET" ? "Macet" : "Diragukan"}`}
                  description="Pilih satu akad untuk membaca dan menambah jejak tindak lanjut penagihannya."
                  footer={<span>{formatCount(data.data.length)} akad memerlukan tindak lanjut.</span>}
                >
                  <DaftarDokumen
                    columns={AKAD_COLUMNS}
                    rows={data.data}
                    rowKey={(row) => row.id}
                    onPilih={(row) => setAkadId(row.id)}
                    emptyTitle="Tidak ada akad pada klasifikasi ini"
                    emptyDescription="Klasifikasi ditetapkan pada closing kolektibilitas."
                    kartu={(row) => ({
                      judul: row.mitraNama,
                      sub: `${row.noAkad} . ${row.mitraKode}`,
                      nilai: formatMoney(row.outstandingPokok),
                      nilaiLabel: "Outstanding",
                      meta: `tunggakan ${row.hariTunggakan} hari`,
                      status: <Kolektibilitas kelas={row.kolektibilitas} />,
                    })}
                  />
                </Panel>
              )
            }
          </Muat>
        </TabPanel>
        <CatatanOtorisasi />
      </HalamanModul>
    );
  }

  const akad = (daftar.data?.data ?? []).find((row) => row.id === akadId) ?? null;

  return (
    <HalamanModul
      route={route}
      title={akad ? `Tindak lanjut akad ${akad.noAkad}` : "Tindak lanjut penagihan"}
      sub={
        akad
          ? `${akad.mitraNama} . tunggakan ${akad.hariTunggakan} hari`
          : "Jejak penagihan atas satu akad bermasalah."
      }
      back={{ to: "/pumk/mitra-bermasalah", label: "Daftar mitra bermasalah" }}
    >
      {akad ? (
        <>
          <RingkasDokumen
            items={[
              { label: "No akad", value: akad.noAkad },
              { label: "Kode mitra", value: akad.mitraKode },
              { label: "Kolektibilitas", value: <Kolektibilitas kelas={akad.kolektibilitas} /> },
              { label: "Hari tunggakan", value: formatCount(akad.hariTunggakan) },
            ]}
          />
          <Bento columns={4}>
            <BentoItem span="sm">
              <Panel as="h2" title="Outstanding pokok" className="panel-kpi">
                <Stat
                  label="Sisa pokok pinjaman"
                  value={formatMoney(akad.outstandingPokok)}
                  hint={`Dari pokok ${formatMoney(akad.pokokPinjaman)}`}
                />
              </Panel>
            </BentoItem>
            <BentoItem span="sm">
              <Panel as="h2" title="Outstanding Jasa Administrasi" className="panel-kpi">
                <Stat label="Jasa yang belum diterima" value={formatMoney(akad.outstandingJasa)} />
              </Panel>
            </BentoItem>
            <BentoItem span="sm">
              <Panel as="h2" title="Hari tunggakan" className="panel-kpi">
                <Stat
                  label="Sejak angsuran tertua jatuh tempo"
                  value={formatCount(akad.hariTunggakan)}
                  hint="Dasar klasifikasi kolektibilitas."
                />
              </Panel>
            </BentoItem>
            <BentoItem span="sm">
              <Panel as="h2" title="Jejak tindak lanjut" className="panel-kpi">
                <Stat
                  label="Sudah tercatat"
                  value={formatCount(trail.data?.data.length ?? 0)}
                  hint="Termasuk kunjungan, telepon, surat, dan somasi."
                />
              </Panel>
            </BentoItem>
          </Bento>
        </>
      ) : null}

      <Panel
        as="h2"
        title="Jejak tindak lanjut penagihan"
        description="Riwayat lengkap tindakan atas akad ini, terbaru di bawah."
        aside={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => navigate(`/pumk/kartu-piutang/${akadId}`)}
          >
            Buka Kartu Piutang
          </Button>
        }
        footer={<span>Setiap baris tercatat beserta petugas dan waktunya pada audit trail.</span>}
      >
        <Muat
          hasil={trail}
          judul="jejak tindak lanjut"
          sumber={`GET /api/pumk/akad/${akadId}/tindak-lanjut`}
        >
          {(data) => (
            <DataTable
              columns={TINDAK_COLUMNS}
              rows={data.data}
              rowKey={(row) => row.id}
              caption="Tindak lanjut penagihan akad ini"
              emptyTitle="Belum ada tindak lanjut tercatat"
              emptyDescription="Catat tindakan pertama melalui form di bawah."
            />
          )}
        </Muat>
      </Panel>

      <form onSubmit={tambah}>
        <Bagian
          title="Catat tindak lanjut"
          description="Satu baris untuk satu tindakan. Hasil wajib diisi agar jejaknya berguna bagi petugas berikutnya."
        >
          <FieldGrid>
            <Field label="Tanggal" htmlFor="tanggal-tindak" required>
              <TextInput
                id="tanggal-tindak"
                type="date"
                value={tanggal}
                disabled={!bolehCatat}
                onChange={(event) => setTanggal(event.currentTarget.value)}
              />
            </Field>
            <Field label="Jenis tindakan" htmlFor="jenis-tindak" required>
              <Select
                id="jenis-tindak"
                value={jenis}
                disabled={!bolehCatat}
                onChange={(event) => setJenis(event.currentTarget.value as JenisTindakLanjut)}
                options={JENIS}
              />
            </Field>
          </FieldGrid>
          <Field label="Hasil" htmlFor="hasil-tindak" required>
            <Textarea
              id="hasil-tindak"
              rows={2}
              value={hasilTindak}
              disabled={!bolehCatat}
              placeholder="Contoh: mitra berjanji menyetor dua angsuran pada akhir bulan"
              onChange={(event) => setHasilTindak(event.currentTarget.value)}
            />
          </Field>
          <Field label="Catatan" htmlFor="catatan-tindak">
            <Textarea
              id="catatan-tindak"
              rows={2}
              value={catatan}
              disabled={!bolehCatat}
              onChange={(event) => setCatatan(event.currentTarget.value)}
            />
          </Field>
          <DataList
            items={[
              { label: "Petugas", value: session.user.nama },
              { label: "Cabang", value: session.cabang.nama },
            ]}
          />
        </Bagian>

        <BarisAksi
          error={simpan.error}
          primary={
            <Button
              type="submit"
              variant="primary"
              disabled={!bolehCatat || hasilTindak.trim() === ""}
              loading={simpan.status === "mengirim"}
              loadingLabel="Menyimpan"
            >
              Simpan tindak lanjut
            </Button>
          }
        />
      </form>

      <CatatanOtorisasi tambahan="Pencatatan tindak lanjut memerlukan hak akses penagihan." />
    </HalamanModul>
  );
}

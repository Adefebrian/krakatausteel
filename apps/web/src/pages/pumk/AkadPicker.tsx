// The akad picker every akad scoped page opens with: jadwal, pencairan,
// penerimaan angsuran, reschedule, pengakhiran and the Kartu Piutang.
//
// One component, so the search box, the columns, the phone card and the empty
// copy are identical on all six, and a person who learns to find an akad on
// one page has learned it on all of them.
import { useState } from "react";
import {
  Panel,
  SearchInput,
  StatusBadge,
  formatCount,
  formatMoney,
} from "@krakatausteel/ui";
import { daftarAkad, type BarisAkad } from "../../api/pumk";
import { useApi } from "../../api/useApi";
import { useActiveSession } from "../../session";
import { AntreanKosong, DaftarDokumen, Kolektibilitas, Muat, type ColumnSpec } from "./parts";

const COLUMNS: readonly ColumnSpec<BarisAkad>[] = [
  { key: "noAkad", header: "No Akad", sortable: true, width: "150px" },
  { key: "tanggalAkad", header: "Tanggal", type: "date", sortable: true, width: "110px" },
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
  { key: "pokokPinjaman", header: "Pokok", type: "money", sortable: true, width: "140px" },
  { key: "outstandingPokok", header: "Outstanding", type: "money", sortable: true, width: "140px" },
  {
    key: "kolektibilitas",
    header: "Kolektibilitas",
    sortable: true,
    width: "150px",
    render: (row) => <Kolektibilitas kelas={row.kolektibilitas} />,
  },
  {
    key: "status",
    header: "Status akad",
    sortable: true,
    width: "140px",
    render: (row) => <StatusBadge status={row.status} />,
  },
];

export function AkadPicker({
  title,
  description,
  status,
  kolektibilitas,
  emptyTitle,
  emptyDescription,
  onPilih,
}: {
  title: string;
  description: string;
  /** Restrict to one akad status, e.g. "AKTIF" for a receipt. */
  status?: string | null;
  kolektibilitas?: string | null;
  emptyTitle: string;
  emptyDescription: string;
  onPilih: (akad: BarisAkad) => void;
}) {
  const session = useActiveSession();
  const [cari, setCari] = useState("");

  const daftar = useApi(
    () =>
      daftarAkad({
        cabangId: session.cabang.id,
        status: status ?? null,
        kolektibilitas: kolektibilitas ?? null,
        cari: cari.trim() || null,
      }),
    [session.cabang.id, status, kolektibilitas, cari],
  );

  return (
    <Panel
      as="h2"
      title={title}
      description={description}
      footer={
        <span>
          {daftar.data ? `${formatCount(daftar.data.data.length)} akad sesuai pencarian.` : "Memuat daftar akad."}
        </span>
      }
    >
      <div className="cari-akad">
        <SearchInput
          label="Cari akad, nama Mitra Binaan, atau NIK"
          placeholder="Nomor akad, nama Mitra Binaan, atau NIK"
          value={cari}
          onChange={(event) => setCari(event.currentTarget.value)}
        />
      </div>
      <Muat hasil={daftar} judul="daftar akad" sumber="GET /api/pumk/akad">
        {(data) =>
          data.data.length === 0 ? (
            <AntreanKosong icon="wallet" title={emptyTitle} description={emptyDescription} />
          ) : (
            <DaftarDokumen
              columns={COLUMNS}
              rows={data.data}
              rowKey={(row) => row.id}
              onPilih={onPilih}
              emptyTitle={emptyTitle}
              emptyDescription={emptyDescription}
              kartu={(row) => ({
                judul: row.mitraNama,
                sub: `${row.noAkad} . ${row.noProposal}`,
                nilai: formatMoney(row.outstandingPokok),
                nilaiLabel: "Outstanding",
                meta: `${row.kolektibilitas ?? "Belum dinilai"} . tunggakan ${row.hariTunggakan} hari`,
                status: <StatusBadge status={row.status} />,
              })}
            />
          )
        }
      </Muat>
    </Panel>
  );
}

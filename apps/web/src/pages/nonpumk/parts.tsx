// Pieces shared by the Non PUMK screens, on top of the module agnostic frame
// in ../shared/parts.
//
// Two of them carry the arithmetic the rest of the module depends on being
// right, and they live here rather than inline on a page so there is exactly
// one implementation of each:
//
//   `Pagu`  the three figures of a staged disbursement: the approved ceiling,
//           what is already out, and what is left. Never one figure.
//   `Sisa`  the three figures of an LPJ: what was disbursed, what was
//           realised, and the remainder that has to come back.
//
// Both take `Uang` strings straight from the server and render them through
// `formatMoney`, so what is on screen is the NUMERIC(20,2) the engine compares
// against, down to the sen. Nothing here rounds anything for display: a termin
// landing exactly on the ceiling is allowed and one sen over it is refused, so
// a remaining figure shown to the nearest rupiah would hide the sen that
// decides it.
import type { ReactNode } from "react";
import {
  Bento,
  BentoItem,
  Icon,
  Panel,
  Stat,
  StatusBadge,
  formatCount,
  formatDate,
  formatMoney,
  type IconName,
} from "@krakatausteel/ui";
import {
  daftarProposal,
  type BarisProposalNonPumk,
  type EmberUmurLpj,
  type SdgProposal,
  type StatusProposalNonPumk,
  type Uang,
} from "../../api/nonpumk";
import { useApi } from "../../api/useApi";
import { useActiveSession } from "../../session";
import { AntreanKosong, DaftarDokumen, Muat, type ColumnSpec } from "../shared/parts";

/**
 * The four ageing buckets of spec 9.2, spelled out.
 *
 * Half open on the left: a grant disbursed exactly 30 days ago is in the 30 to
 * 59 bucket, not the one below it. Written out on screen for the same reason
 * the engine states it in a comment: an off by one in an ageing bucket is
 * invisible in every screenshot and wrong in every management report.
 */
export const EMBER_LPJ: Record<EmberUmurLpj, { label: string; ringkas: string }> = {
  UMUR_0_29: { label: "Kurang dari 30 hari", ringkas: "0 sampai 29 hari" },
  UMUR_30_59: { label: "30 sampai 59 hari", ringkas: "30 sampai 59 hari" },
  UMUR_60_89: { label: "60 sampai 89 hari", ringkas: "60 sampai 89 hari" },
  UMUR_90_PLUS: { label: "90 hari atau lebih", ringkas: "90 hari atau lebih" },
};

export const URUTAN_EMBER: readonly EmberUmurLpj[] = [
  "UMUR_0_29",
  "UMUR_30_59",
  "UMUR_60_89",
  "UMUR_90_PLUS",
];

/**
 * THERE ARE TWO AGES IN THIS MODULE AND THEY ARE NOT THE SAME NUMBER.
 *
 *   `BarisProposalNonPumk.umurHari`   days since the PROPOSAL was raised. How
 *                                     long a document has been sitting in a
 *                                     queue. Rendered by this helper.
 *   `BarisMonitoringLpj.umurHari`     days since the LAST DISBURSEMENT. What
 *                                     the 30/60/90 buckets of spec 9.2 are
 *                                     measured on. Rendered on the monitoring
 *                                     dashboard, never here.
 *
 * On a real programme they differ by months, so both are spelled out on screen
 * as "umur dokumen" and "umur sejak termin terakhir" rather than both as
 * "umur". Both come from the SERVER; neither is computed in the browser, so
 * there is one definition of each and it is not this file's.
 */
export function teksUmurDokumen(hari: number | null | undefined): string {
  return hari === null || hari === undefined
    ? "umur dokumen tidak terbaca"
    : `umur dokumen ${formatCount(hari)} hari`;
}

/**
 * The SDG mapping of a program, as one line.
 *
 * Clamped to a single line in a table cell and on a card, so a program mapped
 * to five goals cannot make its row taller than a program mapped to one. Spec
 * 9.2 makes at least one mandatory, so zero is a data problem and says so
 * instead of rendering as an empty cell.
 */
export function ringkasSdg(sdg: readonly SdgProposal[]): string {
  if (sdg.length === 0) return "Belum dipetakan";
  return sdg.map((item) => `SDG ${item.nomor}`).join(", ");
}

export function SdgDaftar({ sdg }: { sdg: readonly SdgProposal[] }) {
  if (sdg.length === 0) {
    return <p className="penjelasan">Belum dipetakan ke satu pun SDG.</p>;
  }
  return (
    <ul className="sdg-list">
      {sdg.map((item) => (
        <li className="sdg-item" key={item.sdgId}>
          <span className="sdg-nomor">SDG {formatCount(item.nomor)}</span>
          <span className="sdg-nama">{item.nama}</span>
          <span className="sdg-bobot">Bobot {formatMoney(item.bobot)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The ceiling of a staged disbursement, as THREE figures.
 *
 * A grant approved at one amount and paid out in termin has a headroom that
 * decides whether the next termin is accepted at all. Showing only the
 * approved amount leaves the operator to do that subtraction in their head,
 * and showing a rounded remainder makes the sen that decides it invisible, so
 * all three are printed side by side at full precision.
 */
export function Pagu({
  disetujui,
  disalurkan,
  sisa,
  catatanSisa,
  status,
}: {
  disetujui: Uang | null;
  disalurkan: Uang;
  sisa: Uang | null;
  catatanSisa?: string;
  status?: ReactNode;
}) {
  return (
    <Bento columns={3}>
      <BentoItem span="sm">
        <Panel as="h2" title="Nilai disetujui" className="panel-kpi">
          <Stat
            label="Pagu yang boleh disalurkan"
            value={disetujui === null ? "Belum disetujui" : formatMoney(disetujui)}
            hint="Ditetapkan Approver dan tidak dapat dinaikkan setelahnya."
          />
        </Panel>
      </BentoItem>
      <BentoItem span="sm">
        <Panel as="h2" title="Sudah disalurkan" className="panel-kpi">
          <Stat
            label="Total seluruh termin"
            value={formatMoney(disalurkan)}
            hint="Jumlah setiap termin yang sudah tercatat dan berjurnal."
          />
        </Panel>
      </BentoItem>
      <BentoItem span="sm">
        {/* The badge sits on the CARD, not in the figure's own head row: at
            three up it wrapped onto a line of its own and pushed this figure
            below the two beside it, and three figures that are meant to be
            read together have to share one baseline. */}
        <Panel as="h2" title="Sisa pagu" className="panel-kpi" aside={status}>
          <Stat
            label="Masih boleh disalurkan"
            value={sisa === null ? "Belum dapat dihitung" : formatMoney(sisa)}
            hint={catatanSisa ?? "Nilai disetujui dikurangi seluruh termin, tanpa pembulatan."}
          />
        </Panel>
      </BentoItem>
    </Bento>
  );
}

/**
 * The LPJ arithmetic, as THREE figures.
 *
 * When the realisation is smaller than what was disbursed, the difference has
 * to be returned. One figure cannot say that: a realisation of 8.000.000,00
 * only means something next to the 10.000.000,00 that went out and the
 * 2.000.000,00 that has to come back, and it is the remainder, not the
 * realisation, that produces a journal.
 */
export function Sisa({
  disalurkan,
  realisasi,
  sisa,
  catatanSisa,
  status,
}: {
  disalurkan: Uang;
  realisasi: Uang | null;
  sisa: Uang | null;
  catatanSisa?: string;
  status?: ReactNode;
}) {
  return (
    <Bento columns={3}>
      <BentoItem span="sm">
        <Panel as="h2" title="Dana disalurkan" className="panel-kpi">
          <Stat
            label="Total seluruh termin"
            value={formatMoney(disalurkan)}
            hint="Nilai yang benar benar keluar melalui kas atau bank."
          />
        </Panel>
      </BentoItem>
      <BentoItem span="sm">
        <Panel as="h2" title="Realisasi LPJ" className="panel-kpi">
          <Stat
            label="Dipertanggungjawabkan penerima"
            value={realisasi === null ? "Belum diisi" : formatMoney(realisasi)}
            hint="Nilai yang benar benar dipakai untuk program."
          />
        </Panel>
      </BentoItem>
      <BentoItem span="sm">
        <Panel as="h2" title="Sisa dikembalikan" className="panel-kpi" aside={status}>
          <Stat
            label="Wajib kembali ke kas"
            value={sisa === null ? "Belum dapat dihitung" : formatMoney(sisa)}
            hint={
              catatanSisa ??
              "Dana disalurkan dikurangi realisasi, tanpa pembulatan. Sisa di atas nol membentuk jurnal pengembalian saat LPJ diterima."
            }
          />
        </Panel>
      </BentoItem>
    </Bento>
  );
}

const KOLOM_ANTREAN: readonly ColumnSpec<BarisProposalNonPumk>[] = [
  { key: "noProposal", header: "No Proposal", sortable: true, width: "160px" },
  {
    key: "namaPemohon",
    header: "Pemohon",
    sortable: true,
    render: (row) => (
      <span className="sel-utama">
        <span className="sel-utama-judul">{row.namaPemohon}</span>
        <span className="sel-utama-sub">{row.judulProgram}</span>
      </span>
    ),
  },
  { key: "bidangNama", header: "Bidang", sortable: true, width: "150px" },
  {
    key: "sdg",
    header: "SDG",
    width: "130px",
    render: (row) => <span className="sel-ringkas">{ringkasSdg(row.sdg)}</span>,
  },
  { key: "jumlahDiajukan", header: "Nilai Diajukan", type: "money", sortable: true, width: "150px" },
  { key: "umurHari", header: "Umur dokumen (hari)", type: "count", sortable: true, width: "150px" },
];

/**
 * The queue every Non PUMK action page opens on: one status, one request, one
 * list. A page that needs two statuses renders two of these behind tabs rather
 * than merging them, so the count on screen is always a real count of one
 * server answer under one filter.
 */
export function Antrean({
  status,
  title,
  description,
  emptyTitle,
  emptyDescription,
  emptyIcon = "checkCircle",
  onPilih,
}: {
  status: StatusProposalNonPumk;
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  emptyIcon?: IconName;
  onPilih: (row: BarisProposalNonPumk) => void;
}) {
  const session = useActiveSession();
  const antrean = useApi(
    () => daftarProposal({ cabangId: session.cabang.id, status }),
    [session.cabang.id, status],
  );

  return (
    <Muat
      hasil={antrean}
      judul="antrean proposal"
      sumber={`GET /api/nonpumk/proposal?status=${status}`}
    >
      {(data) =>
        data.data.length === 0 ? (
          <AntreanKosong icon={emptyIcon} title={emptyTitle} description={emptyDescription} />
        ) : (
          <Panel
            as="h2"
            title={title}
            description={description}
            footer={<span>{formatCount(data.data.length)} proposal pada antrean ini.</span>}
          >
            <DaftarDokumen
              columns={KOLOM_ANTREAN}
              rows={data.data}
              rowKey={(row) => row.id}
              onPilih={onPilih}
              emptyTitle={emptyTitle}
              emptyDescription={emptyDescription}
              kartu={(row) => ({
                judul: row.namaPemohon,
                sub: `${row.noProposal} . ${row.bidangNama}`,
                nilai: formatMoney(row.jumlahDiajukan),
                nilaiLabel: "Diajukan",
                meta: `${ringkasSdg(row.sdg)} . ${teksUmurDokumen(row.umurHari)}`,
                status: <StatusBadge status={row.status} />,
              })}
            />
          </Panel>
        )
      }
    </Muat>
  );
}

/** The notice shown before a click one of the rules in spec 2 will refuse. */
export function Peringatan({ judul, children }: { judul: string; children: ReactNode }) {
  return (
    <div className="peringatan" role="alert">
      <Icon name="lock" size={18} />
      <div>
        <p className="peringatan-judul">{judul}</p>
        <p className="peringatan-teks">{children}</p>
      </div>
    </div>
  );
}

/** Identity of the program under the page title, one chip per fact. */
export function RingkasProgram({
  proposal,
  bidangNama,
  cabangNama,
  sdg,
}: {
  proposal: { noProposal: string; tanggalProposal: string; judulProgram: string };
  bidangNama: string;
  cabangNama: string;
  sdg: readonly SdgProposal[];
}) {
  const items = [
    { label: "No proposal", value: proposal.noProposal },
    { label: "Tanggal", value: formatDate(proposal.tanggalProposal) },
    { label: "Bidang", value: bidangNama },
    { label: "SDG", value: ringkasSdg(sdg) },
    { label: "Cabang", value: cabangNama },
  ];
  return (
    <div className="ringkas">
      {items.map((item) => (
        <span className="ringkas-item" key={item.label}>
          <span className="ringkas-key">{item.label}</span>
          <span className="ringkas-val">{item.value}</span>
        </span>
      ))}
    </div>
  );
}

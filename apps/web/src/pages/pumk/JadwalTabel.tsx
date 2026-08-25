// The instalment table, drawn the same way everywhere it appears: the schedule
// page, the reschedule preview, the simulator and the Kartu Piutang.
//
// The column totals are computed with the exact adder in packages/ui, never
// with a float, and the total pokok is shown next to the akad's principal so
// the invariant "the schedule's principal equals the loan's principal" is
// readable on the page rather than only asserted in a test.
import { DataList, DataTable, formatCount, formatMoney, formatRate, formatTotal, type Column } from "@krakatausteel/ui";
import type { BarisJadwal, ParameterTerpakai, RingkasanJadwal } from "@krakatausteel/api/src/modules/angsuran/contract";

const COLUMNS: readonly Column<BarisJadwal>[] = [
  { key: "angsuranKe", header: "Ke", type: "count", width: "70px" },
  { key: "tanggalJatuhTempo", header: "Jatuh tempo", type: "date", width: "130px" },
  { key: "pokok", header: "Pokok", type: "money" },
  { key: "jasaAdm", header: "Jasa Administrasi", type: "money" },
  { key: "total", header: "Total angsuran", type: "money" },
  { key: "saldoPokokSetelah", header: "Sisa pokok", type: "money" },
];

export function JadwalTabel({
  baris,
  caption,
}: {
  baris: readonly BarisJadwal[];
  caption?: string;
}) {
  const columns = COLUMNS.map((column) => {
    if (column.key === "pokok") {
      return { ...column, footer: formatTotal(baris.map((row) => row.pokok)) };
    }
    if (column.key === "jasaAdm") {
      return { ...column, footer: formatTotal(baris.map((row) => row.jasaAdm)) };
    }
    if (column.key === "total") {
      return { ...column, footer: formatTotal(baris.map((row) => row.total)) };
    }
    if (column.key === "angsuranKe") {
      return { ...column, footer: formatCount(baris.length) };
    }
    return { ...column, footer: "" };
  });

  return (
    <DataTable
      columns={columns}
      rows={baris}
      rowKey={(row) => String(row.angsuranKe)}
      caption={caption}
      emptyTitle="Belum ada baris jadwal"
      emptyDescription="Jadwal terbentuk setelah akad dibuat dan jadwal digenerate."
    />
  );
}

export function RingkasanJadwalPanel({ ringkasan }: { ringkasan: RingkasanJadwal }) {
  return (
    <DataList
      items={[
        { label: "Total pokok", value: formatMoney(ringkasan.totalPokok), numeric: true },
        { label: "Total Jasa Administrasi", value: formatMoney(ringkasan.totalJasa), numeric: true },
        { label: "Total dibayar", value: formatMoney(ringkasan.totalBayar), numeric: true },
        { label: "Angsuran per bulan", value: formatMoney(ringkasan.angsuranPerBulan), numeric: true },
        { label: "Jumlah baris", value: formatCount(ringkasan.jumlahBaris), numeric: true },
      ]}
    />
  );
}

export function ParameterPanel({ parameter }: { parameter: ParameterTerpakai }) {
  return (
    <DataList
      items={[
        { label: "Pokok", value: formatMoney(parameter.pokok), numeric: true },
        { label: "Rate", value: `${formatRate(parameter.rate)} persen per tahun`, numeric: true },
        { label: "Metode", value: parameter.metode },
        { label: "Tenor", value: `${formatCount(parameter.tenorBulan)} bulan`, numeric: true },
        {
          label: "Grace period",
          value: `${formatCount(parameter.gracePeriodBulan)} bulan`,
          numeric: true,
        },
        { label: "Pembulatan", value: formatMoney(parameter.pembulatan), numeric: true },
        { label: "Jasa saat grace", value: parameter.jasaGrace },
        { label: "Basis hari", value: formatCount(parameter.basisHari), numeric: true },
      ]}
    />
  );
}

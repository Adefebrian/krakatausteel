// Catalog page for one section of the report inventory.
//
// The table is real metadata from spec section 10, not sample data: the report
// number, name, key columns, and grouping are exactly what the report will
// deliver. Clicking a row opens that report's own page.
import { useMemo, useState } from "react";
import { DataTable, FilterBar, Icon, type Column } from "@krakatausteel/ui";
import { useRouter } from "../router";
import { reportPath, reportsInGroup, type ReportGroup, type ReportMeta } from "../reports";
import { useActiveSession } from "../session";

export function ReportCatalog({ group }: { group: ReportGroup }) {
  const session = useActiveSession();
  const { navigate } = useRouter();
  const [periode, setPeriode] = useState({
    tahun: session.periode.tahun,
    bulan: session.periode.bulan,
  });
  const [cabang, setCabang] = useState(session.cabang.id);
  const [search, setSearch] = useState("");

  const reports = reportsInGroup(group.id);
  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query === "") return reports;
    return reports.filter(
      (report) =>
        report.nama.toLowerCase().includes(query) ||
        report.kolomKunci.toLowerCase().includes(query),
    );
  }, [reports, search]);

  const columns: readonly Column<ReportMeta>[] = [
    { key: "no", header: "No", type: "count", sortable: true, width: "64px" },
    { key: "nama", header: "Nama laporan", sortable: true },
    { key: "kolomKunci", header: "Kolom kunci" },
    { key: "pengelompokan", header: "Pengelompokan" },
  ];

  const cabangOptions = session.cabangTersedia.map((entry) => ({
    value: entry.id,
    label: `${entry.kode} ${entry.nama}`,
  }));

  return (
    <div className="page">
      <header className="page-head">
        <p className="page-crumb">Laporan</p>
        <h1 className="page-title">{group.label}</h1>
        <p className="page-sub">{group.description}</p>
      </header>

      <FilterBar
        periode={periode}
        onPeriodeChange={setPeriode}
        cabang={cabang}
        onCabangChange={setCabang}
        cabangOptions={cabangOptions}
        search={search}
        onSearchChange={setSearch}
        searchLabel="Cari laporan"
        searchPlaceholder="Cari nama laporan atau kolom"
        onReset={() => {
          setPeriode({ tahun: session.periode.tahun, bulan: session.periode.bulan });
          setCabang(session.cabang.id);
          setSearch("");
        }}
      />

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(report) => report.slug}
        emptyTitle="Tidak ada laporan yang cocok"
        emptyDescription="Ubah kata pencarian untuk melihat laporan lain pada kelompok ini."
        onRowClick={(report) => navigate(reportPath(report.slug))}
      />

      <p className="page-note">
        <Icon name="info" size={16} />
        <span>
          Filter periode dan cabang di atas sudah menjadi kontrak setiap laporan. Query, export
          Excel, dan export PDF dibangun pada Fase 6.
        </span>
      </p>
    </div>
  );
}

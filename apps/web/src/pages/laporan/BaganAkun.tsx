// 16. Bagan Akun, spec 10.3. The chart of accounts as a tree.
//
// THE ONE REPORT WITH NO PERIOD AND NO BRANCH, and the screen says so instead
// of showing two selectors the server would ignore. A chart of accounts is a
// STRUCTURE: offering a month above it would invite a reader to believe the
// tree changed with the month, and offering a branch would suggest each branch
// keeps its own accounts. `GET /laporan/bagan-akun` takes `hanyaAktif` alone,
// which is the only filter here.
//
// INACTIVE ACCOUNTS ARE SHOWN BY DEFAULT, because spec 10.3 report 16 asks for
// a `status` column and a status column over a list filtered down to the
// active rows says nothing at all.
import { useMemo, useState } from "react";
import { Icon, Panel, StatusBadge } from "@krakatausteel/ui";
import { baganAkun, type BarisBaganAkun, type LaporanBaganAkun } from "../../api/laporan";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { Muat } from "../shared/parts";
import { KopLaporan } from "./parts";

const LABEL_TIPE: Record<string, string> = {
  ASET: "Aset",
  LIABILITAS: "Liabilitas",
  ASET_NETO: "Aset Neto",
  PENDAPATAN: "Pendapatan",
  BEBAN: "Beban",
};

const LABEL_ARUS_KAS: Record<string, string> = {
  OPERASI: "Arus kas operasi",
  INVESTASI: "Arus kas investasi",
  PENDANAAN: "Arus kas pendanaan",
};

export function BaganAkunPage({ route }: { route: PageRoute }) {
  const [hanyaAktif, setHanyaAktif] = useState(false);
  const hasil = useApi(() => baganAkun(hanyaAktif), [hanyaAktif]);

  return (
    <div className="page laporan-page">
      <header className="page-head">
        <p className="page-crumb">Laporan Akuntansi</p>
        <div className="page-head-row">
          <div className="page-head-text">
            <h1 className="page-title">{route.title}</h1>
            <p className="page-sub">{route.summary}</p>
          </div>
        </div>
      </header>

      <div className="filter-laporan">
        <label className="filter-laporan-check">
          <input
            type="checkbox"
            checked={hanyaAktif}
            onChange={(event) => setHanyaAktif(event.currentTarget.checked)}
          />
          <span>Tampilkan akun aktif saja</span>
        </label>
      </div>

      <Muat hasil={hasil} judul="bagan akun" sumber="GET /api/laporan/bagan-akun">
        {(data: LaporanBaganAkun) => (
          <>
            <KopLaporan header={data.header} />
            <p className="page-note">
              <Icon name="info" size={16} />
              <span>
                Laporan ini tidak punya filter periode dan tidak punya filter cabang: bagan akun
                adalah struktur entitas, bukan saldo satu bulan. Tanggal pada header adalah
                tanggal susunan ini dibaca, bukan periode akuntansi yang dipilih.
              </span>
            </p>
            <Panel as="h2" title="Struktur akun" description={`${data.baris.length} akun.`}>
              <PohonAkun baris={data.baris} />
            </Panel>
          </>
        )}
      </Muat>
    </div>
  );
}

function PohonAkun({ baris }: { baris: readonly BarisBaganAkun[] }) {
  const anak = useMemo(() => {
    const peta = new Map<string, BarisBaganAkun[]>();
    for (const row of baris) {
      const kunci = row.parentId ?? "";
      const daftar = peta.get(kunci);
      if (daftar) daftar.push(row);
      else peta.set(kunci, [row]);
    }
    return peta;
  }, [baris]);

  // An account whose parent is not in the answer (a filtered out inactive
  // parent) is rendered at the root rather than dropped, so a filter can never
  // make an account disappear from its own chart.
  const adaId = useMemo(() => new Set(baris.map((row) => row.akunId)), [baris]);
  const akar = useMemo(
    () => baris.filter((row) => row.parentId === null || !adaId.has(row.parentId)),
    [baris, adaId],
  );

  const [tutup, setTutup] = useState<ReadonlySet<string>>(() => new Set<string>());

  if (baris.length === 0) {
    return (
      <div className="antrean-kosong">
        <span className="antrean-kosong-icon" aria-hidden="true">
          <Icon name="list" size={20} />
        </span>
        <p className="antrean-kosong-title">Bagan akun kosong</p>
        <p className="antrean-kosong-desc">
          Server menjawab tanpa satu akun pun. Master bagan akun belum diisi untuk entitas ini.
        </p>
      </div>
    );
  }

  function toggle(id: string) {
    setTutup((sebelum) => {
      const next = new Set(sebelum);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function render(row: BarisBaganAkun, kedalaman: number): JSX.Element[] {
    const anakRow = anak.get(row.akunId) ?? [];
    const terbuka = !tutup.has(row.akunId);
    const keluar: JSX.Element[] = [
      <li key={row.akunId} className={`coa-row is-level-${Math.min(kedalaman, 4)}`}>
        <span className="coa-utama">
          {anakRow.length > 0 ? (
            <button
              type="button"
              className="coa-toggle"
              aria-expanded={terbuka}
              aria-label={terbuka ? `Tutup ${row.nama}` : `Buka ${row.nama}`}
              onClick={() => toggle(row.akunId)}
            >
              <Icon name={terbuka ? "chevronDown" : "chevronRight"} size={16} />
            </button>
          ) : (
            <span className="coa-toggle is-kosong" aria-hidden="true" />
          )}
          <span className="coa-kode">{row.kode}</span>
          <span className="coa-nama">{row.nama}</span>
        </span>
        <span className="coa-meta">
          <span className="coa-tipe">{LABEL_TIPE[row.tipe] ?? row.tipe}</span>
          <span className="coa-normal">Saldo normal {row.saldoNormal === "D" ? "Debit" : "Kredit"}</span>
          <span className="coa-tanda">
            {row.isPostable ? "Bisa dijurnal" : "Header"}
            {row.isKas ? ", kas" : ""}
            {row.isKontra ? ", kontra" : ""}
            {row.klasifikasiArusKas
              ? `, ${LABEL_ARUS_KAS[row.klasifikasiArusKas] ?? row.klasifikasiArusKas}`
              : ""}
          </span>
        </span>
        <span className="coa-status">
          <StatusBadge status={row.status} />
        </span>
      </li>,
    ];
    if (terbuka) {
      for (const child of anakRow) keluar.push(...render(child, kedalaman + 1));
    }
    return keluar;
  }

  return (
    <div className="coa">
      <div className="coa-head" role="presentation">
        <span className="coa-utama">Kode dan nama akun</span>
        <span className="coa-meta">Tipe, saldo normal, sifat</span>
        <span className="coa-status">Status</span>
      </div>
      <ul className="coa-list">{akar.flatMap((row) => render(row, 0))}</ul>
    </div>
  );
}

// Placeholder page for every module and report route that Fase 0 does not
// implement yet.
//
// It is driven entirely by the route table, so a page cannot exist without
// stating what it is for and what will live in it. The build phase note comes
// from spec section 14, so a reviewer can tell "not built yet" apart from
// "missing from the plan".
import { EmptyState, Icon } from "@krakatausteel/ui";
import type { PageRoute } from "../nav";
import { groupOfPath } from "../nav";

const FASE_PER_GROUP: Record<string, string> = {
  jurnal: "Fase 1, Engine Jurnal",
  pumk: "Fase 2 dan Fase 3, Engine Angsuran lalu Modul PUMK",
  nonpumk: "Fase 4, Modul Non PUMK",
  admin: "Fase 5 dan Fase 6, Engine Closing lalu RKA",
  laporan: "Fase 6, RKA dan Laporan",
  portal: "Fase 7, Dashboard dan Portal Online",
  tools: "Fase 7, Dashboard dan Portal Online",
  konfigurasi: "Fase 0 dan Fase 1, Fondasi lalu Engine Jurnal",
};

export function Placeholder({ route }: { route: PageRoute }) {
  const group = groupOfPath(route.path);
  const fase = group ? FASE_PER_GROUP[group.id] : undefined;

  return (
    <div className="page">
      <header className="page-head">
        {group ? <p className="page-crumb">{group.label}</p> : null}
        <h1 className="page-title">{route.title}</h1>
        <p className="page-sub">{route.summary}</p>
      </header>

      <EmptyState
        icon={group?.icon ?? "list"}
        title="Halaman belum diisi"
        description="Kerangka navigasi dan hak akses halaman ini sudah aktif. Isinya dibangun pada fase berikutnya."
        willContain={route.willContain}
        footnote={fase ? `Dijadwalkan pada ${fase}.` : undefined}
      />

      <p className="page-note">
        <Icon name="info" size={16} />
        <span>
          Hak akses halaman ini juga divalidasi ulang di server. Menu yang tersembunyi bukan
          pengaman, penolakan tetap terjadi di layer API.
        </span>
      </p>
    </div>
  );
}

// Placeholder page for every module and report route that Fase 0 does not
// implement yet.
//
// It is driven entirely by the route table, so a page cannot exist without
// stating what it is for and what will live in it. The build phase note comes
// from spec section 14, so a reviewer can tell "not built yet" apart from
// "missing from the plan".
import { useState } from "react";
import { EmptyState, Icon, Panel, Select } from "@krakatausteel/ui";
import type { PageRoute } from "../nav";
import { groupOfPath } from "../nav";
import {
  barisTemplate,
  DASAR_HUKUM,
  TEMPLATE_DEFAULT,
  TEMPLATE_LAPORAN,
  templateById,
  type TemplateLaporanId,
} from "../regulasi";

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

function slugOf(path: string): string {
  return path.startsWith("/laporan/") ? path.slice("/laporan/".length) : "";
}

export function Placeholder({ route }: { route: PageRoute }) {
  const group = groupOfPath(route.path);
  const fase = group ? FASE_PER_GROUP[group.id] : undefined;
  const slug = slugOf(route.path);
  const [templateId, setTemplateId] = useState<TemplateLaporanId>(TEMPLATE_DEFAULT);
  const baris = barisTemplate(slug, templateId);
  const template = templateById(templateId);

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

      {baris ? (
        <Panel
          as="h2"
          title="Template baris laporan"
          description="Nama baris aset neto dibaca dari template yang aktif, bukan ditulis di halaman. Dua istilah berlaku bersamaan, dan laporan periode lampau tetap memakai template yang berlaku saat itu."
          footer={
            <span>
              {template.dasar}. {template.berlaku}.
            </span>
          }
        >
          <div className="template-picker">
            <Select
              aria-label="Template baris laporan"
              value={templateId}
              onChange={(event) => setTemplateId(event.currentTarget.value as TemplateLaporanId)}
              options={TEMPLATE_LAPORAN.map((item) => ({ value: item.id, label: item.label }))}
            />
            <ul className="template-lines">
              {baris.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </Panel>
      ) : null}

      <p className="page-note">
        <Icon name="info" size={16} />
        <span>
          Hak akses halaman ini juga divalidasi ulang di server. Menu yang tersembunyi bukan
          pengaman, penolakan tetap terjadi di layer API. Dasar hukum aktif: {DASAR_HUKUM.nomor}.
        </span>
      </p>
    </div>
  );
}

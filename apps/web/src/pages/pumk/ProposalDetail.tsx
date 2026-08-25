// Detail Proposal, spec 9.1, and the home of the approval timeline.
//
// Spec 9.1 says the timeline is "fitur yang paling sering diminta user dan
// paling sering dilupakan developer", so it is not a tab and not a drawer: it
// is a full panel on the first screen of this page, and it carries all four
// things a transition records, who, when, into what state, with what note.
//
// The timeline is drawn without a vertical rail or marker dots. Order comes
// from the numbered step and the row divider (see packages/ui/src/Timeline),
// because a decorative connector line is banned by the frontend rules.
import { useMemo } from "react";
import {
  Bento,
  BentoItem,
  Button,
  DataList,
  DataTable,
  Icon,
  Panel,
  Stat,
  StatusBadge,
  Timeline,
  formatCount,
  formatDate,
  formatMoney,
  formatRate,
  type Column,
  type TimelineEntry,
} from "@krakatausteel/ui";
import { detailProposal, type BarisJaminan, type BarisTransisi } from "../../api/pumk";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { hasPermission, namaRole } from "../../permissions";
import { useRouter } from "../../router";
import { useActiveSession } from "../../session";
import { CatatanOtorisasi, Muat, PumkPage, RingkasDokumen } from "./parts";

const AKSI_LABEL: Record<string, string> = {
  SUBMIT_SURVEY: "Diajukan untuk survey",
  INPUT_SURVEY: "Hasil survey diinput",
  AJUKAN_CHECKER: "Diajukan ke Checker",
  REKOMENDASI: "Direkomendasikan Checker",
  TIDAK_REKOMENDASI: "Tidak direkomendasikan Checker",
  MINTA_PERBAIKAN: "Dikembalikan untuk perbaikan",
  SETUJU: "Disetujui Approver",
  TOLAK: "Ditolak Approver",
  KEMBALIKAN: "Dikembalikan ke Checker",
  BUAT_AKAD: "Akad dibuat",
  GENERATE_JADWAL: "Jadwal angsuran dibuat",
  PENCAIRAN: "Pencairan dicatat",
};

const JAMINAN_COLUMNS: readonly Column<BarisJaminan>[] = [
  { key: "jenis", header: "Jenis", width: "130px" },
  { key: "deskripsi", header: "Deskripsi", render: (row) => row.deskripsi ?? "Belum diisi" },
  { key: "atasNama", header: "Atas nama", render: (row) => row.atasNama ?? "Belum diisi" },
  { key: "nomorDokumen", header: "No dokumen", render: (row) => row.nomorDokumen ?? "Belum diisi" },
  { key: "nilaiTaksasi", header: "Nilai taksasi", type: "money", width: "150px" },
  {
    key: "statusFisik",
    header: "Fisik",
    width: "130px",
    render: (row) => (row.statusFisik ? <StatusBadge status={row.statusFisik} /> : "Tidak dicatat"),
  },
];

function keTimeline(rows: readonly BarisTransisi[]): TimelineEntry[] {
  return rows.map((row, index) => ({
    id: `${row.waktu}-${index}`,
    status: row.statusKe,
    action: AKSI_LABEL[row.aksi] ?? row.aksi,
    actor: row.olehNama ?? "Pengguna tidak tercatat",
    actorRole: row.olehRole ? namaRole(row.olehRole) : undefined,
    at: new Date(row.waktu).toLocaleString("id-ID", {
      day: "2-digit",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
    note: row.catatan ?? undefined,
  }));
}

export function ProposalDetail({ route, proposalId }: { route: PageRoute; proposalId: string }) {
  const session = useActiveSession();
  const { navigate } = useRouter();
  const detail = useApi(() => detailProposal(proposalId), [proposalId]);

  const izin = session.permissions;
  const entries = useMemo(() => keTimeline(detail.data?.timeline ?? []), [detail.data]);

  return (
    <PumkPage
      route={route}
      title={detail.data ? `Proposal ${detail.data.proposal.noProposal}` : route.title}
      sub={
        detail.data
          ? `${detail.data.proposal.mitraNama} . ${detail.data.proposal.cabangNama}`
          : route.summary
      }
      back={{ to: "/pumk/proposal", label: "Daftar Proposal" }}
      actions={
        detail.data ? <StatusBadge status={detail.data.proposal.status} /> : null
      }
    >
      <Muat
        hasil={detail}
        judul="detail proposal"
        sumber={`GET /api/pumk/proposal/${proposalId}`}
      >
        {(data) => {
          const { proposal, survey, jaminan, approval, akad } = data;
          const lanjutan: Array<{ label: string; to: string; izinPerlu: string }> = [];
          if (proposal.status === "SURVEY_PENDING") {
            lanjutan.push({ label: "Input hasil survey", to: `/pumk/survey?proposal=${proposal.id}`, izinPerlu: "pumk.survey" });
          }
          if (proposal.status === "REVIEW_CHECKER") {
            lanjutan.push({ label: "Buka review Checker", to: `/pumk/review?proposal=${proposal.id}`, izinPerlu: "pumk.review" });
          }
          if (proposal.status === "MENUNGGU_PERSETUJUAN") {
            lanjutan.push({ label: "Buka persetujuan", to: `/pumk/persetujuan?proposal=${proposal.id}`, izinPerlu: "pumk.approve" });
          }
          if (proposal.status === "DISETUJUI") {
            lanjutan.push({ label: "Buat akad", to: `/pumk/akad?proposal=${proposal.id}`, izinPerlu: "pumk.akad" });
          }
          if (proposal.status === "AKAD_DIBUAT" || proposal.status === "JADWAL_SIAP") {
            lanjutan.push({ label: "Jadwal angsuran", to: `/pumk/jadwal?akad=${akad?.id ?? ""}`, izinPerlu: "pumk.view" });
          }
          if (proposal.status === "JADWAL_SIAP") {
            lanjutan.push({ label: "Catat pencairan", to: `/pumk/pencairan?akad=${akad?.id ?? ""}`, izinPerlu: "pumk.pencairan" });
          }
          if (akad) {
            lanjutan.push({ label: "Kartu Piutang", to: `/pumk/kartu-piutang/${akad.id}`, izinPerlu: "pumk.view" });
          }
          lanjutan.push({ label: "Profil jaminan", to: `/pumk/jaminan?proposal=${proposal.id}`, izinPerlu: "pumk.create" });

          return (
            <>
              <RingkasDokumen
                items={[
                  { label: "No proposal", value: proposal.noProposal },
                  { label: "Tanggal", value: formatDate(proposal.tanggalProposal) },
                  { label: "Cabang", value: proposal.cabangNama },
                  {
                    label: "Sumber",
                    value:
                      proposal.sumberPengajuan === "PORTAL_ONLINE"
                        ? "Portal Online"
                        : "Internal cabang",
                  },
                  { label: "Langkah", value: formatCount(proposal.currentStep) },
                ]}
              />

              <Bento columns={4}>
                <BentoItem span="sm">
                  <Panel title="Nilai diajukan" as="h2" className="panel-kpi">
                    <Stat
                      label="Sesuai pengajuan Mitra Binaan"
                      value={formatMoney(proposal.jumlahDiajukan)}
                      hint={`Tenor ${formatCount(proposal.tenorDiajukan)} bulan`}
                    />
                  </Panel>
                </BentoItem>
                <BentoItem span="sm">
                  <Panel title="Nilai disetujui" as="h2" className="panel-kpi">
                    <Stat
                      label="Hasil keputusan Approver"
                      value={
                        approval?.plafonDisetujui
                          ? formatMoney(approval.plafonDisetujui)
                          : "Belum diputuskan"
                      }
                      hint={
                        approval?.tenorDisetujui
                          ? `Tenor ${formatCount(approval.tenorDisetujui)} bulan`
                          : "Menunggu keputusan"
                      }
                    />
                  </Panel>
                </BentoItem>
                <BentoItem span="sm">
                  <Panel title="Hasil survey" as="h2" className="panel-kpi">
                    <Stat
                      label="Skor total"
                      value={survey?.skorTotal ? formatMoney(survey.skorTotal) : "Belum disurvey"}
                      hint={
                        survey?.tanggalSurvey
                          ? `Survey ${formatDate(survey.tanggalSurvey)}`
                          : "Belum ada kunjungan tercatat"
                      }
                    />
                  </Panel>
                </BentoItem>
                <BentoItem span="sm">
                  <Panel title="Umur dokumen" as="h2" className="panel-kpi">
                    <Stat
                      label="Sejak tanggal proposal"
                      value={`${formatCount(proposal.umurHari)} hari`}
                      hint={`Sektor ${proposal.sektorNama ?? "belum diisi"}`}
                    />
                  </Panel>
                </BentoItem>
              </Bento>

              <Panel
                as="h2"
                title="Timeline persetujuan"
                description="Setiap perpindahan status dicatat lengkap: siapa yang melakukannya, kapan, dan catatan apa yang ditulis."
                footer={
                  <span>
                    {formatCount(entries.length)} transisi tercatat. Riwayat ini tidak dapat diubah
                    dari halaman mana pun.
                  </span>
                }
              >
                <Timeline
                  entries={entries}
                  emptyLabel="Belum ada transisi. Proposal masih berstatus draft."
                />
              </Panel>

              <Bento columns={2}>
                <BentoItem span="sm">
                  <Panel
                    as="h2"
                    title="Data proposal"
                    footer={
                      <span>
                        Sumber: pumk_proposal. Nomor proposal dibuat oleh generator nomor dokumen.
                      </span>
                    }
                  >
                    <DataList
                      items={[
                        { label: "No proposal", value: proposal.noProposal },
                        { label: "Tanggal proposal", value: formatDate(proposal.tanggalProposal) },
                        { label: "Sektor", value: proposal.sektorNama ?? "Belum diisi" },
                        {
                          label: "Jumlah diajukan",
                          value: formatMoney(proposal.jumlahDiajukan),
                          numeric: true,
                        },
                        {
                          label: "Tenor diajukan",
                          value: `${formatCount(proposal.tenorDiajukan)} bulan`,
                          numeric: true,
                        },
                        {
                          label: "Tujuan penggunaan",
                          value: proposal.tujuanPenggunaan ?? "Belum diisi",
                          wide: true,
                        },
                      ]}
                    />
                  </Panel>
                </BentoItem>
                <BentoItem span="sm">
                  <Panel
                    as="h2"
                    title="Mitra Binaan"
                    footer={
                      <span>Sumber: master mitra. Perubahan data mitra dilakukan di halaman Mitra Binaan.</span>
                    }
                  >
                    <DataList
                      items={[
                        { label: "Nama", value: proposal.mitraNama },
                        { label: "Kode mitra", value: proposal.mitraKode },
                        { label: "NIK", value: proposal.mitraNik ?? "Belum diisi" },
                        { label: "Cabang", value: proposal.cabangNama },
                        {
                          label: "Sumber pengajuan",
                          value:
                            proposal.sumberPengajuan === "PORTAL_ONLINE"
                              ? "Portal Online"
                              : "Internal cabang",
                        },
                        {
                          label: "No submission portal",
                          value: proposal.portalSubmissionId ?? "Tidak berasal dari portal",
                        },
                      ]}
                    />
                  </Panel>
                </BentoItem>
              </Bento>

              <Bento columns={2}>
                <BentoItem span="sm">
                  <Panel
                    as="h2"
                    title="Hasil survey"
                    footer={
                      <span>
                        {survey
                          ? "Skor dan rekomendasi menjadi dasar pertimbangan Checker."
                          : "Belum ada hasil survey untuk proposal ini."}
                      </span>
                    }
                  >
                    {survey ? (
                      <DataList
                        items={[
                          { label: "Tanggal survey", value: formatDate(survey.tanggalSurvey) },
                          {
                            label: "Skor total",
                            value: formatMoney(survey.skorTotal ?? "0.00"),
                            numeric: true,
                          },
                          {
                            label: "Plafon rekomendasi",
                            value: formatMoney(survey.plafonRekomendasi ?? "0.00"),
                            numeric: true,
                          },
                          {
                            label: "Tenor rekomendasi",
                            value: `${formatCount(survey.tenorRekomendasi ?? 0)} bulan`,
                            numeric: true,
                          },
                          { label: "Catatan surveyor", value: survey.catatan ?? "Tidak ada catatan", wide: true },
                        ]}
                      />
                    ) : (
                      <p className="penjelasan">
                        Survey belum diinput. Petugas dengan hak akses survey dapat mengisinya dari
                        halaman Hasil Survey.
                      </p>
                    )}
                  </Panel>
                </BentoItem>
                <BentoItem span="sm">
                  <Panel
                    as="h2"
                    title="Keputusan dan akad"
                    footer={
                      <span>
                        {akad
                          ? "Akad memakai plafon dan tenor hasil persetujuan, bukan nilai pengajuan."
                          : "Akad terbentuk setelah proposal disetujui."}
                      </span>
                    }
                  >
                    <DataList
                      items={[
                        { label: "Keputusan", value: approval?.keputusan ?? "Belum diputuskan" },
                        {
                          label: "Plafon disetujui",
                          value: approval?.plafonDisetujui
                            ? formatMoney(approval.plafonDisetujui)
                            : "Belum ada",
                          numeric: true,
                        },
                        {
                          label: "Tenor disetujui",
                          value: approval?.tenorDisetujui
                            ? `${formatCount(approval.tenorDisetujui)} bulan`
                            : "Belum ada",
                          numeric: true,
                        },
                        {
                          label: "Rate Jasa Administrasi",
                          value: approval?.jasaAdmRate ? `${formatRate(approval.jasaAdmRate)} persen` : "Belum ada",
                          numeric: true,
                        },
                        { label: "No akad", value: akad?.noAkad ?? "Belum ada akad" },
                        {
                          label: "Catatan keputusan",
                          value: approval?.catatan ?? "Tidak ada catatan",
                          wide: true,
                        },
                      ]}
                    />
                  </Panel>
                </BentoItem>
              </Bento>

              <Panel
                as="h2"
                title="Profil jaminan"
                description="Satu proposal dapat memiliki lebih dari satu jaminan. Ambang wajib jaminan dibaca dari Parameter Sistem."
                footer={
                  <span>{formatCount(jaminan.length)} jaminan tercatat pada proposal ini.</span>
                }
              >
                <DataTable
                  columns={JAMINAN_COLUMNS}
                  rows={jaminan}
                  rowKey={(row) => row.id}
                  emptyTitle="Belum ada jaminan tercatat"
                  emptyDescription="Tambahkan melalui halaman Profil Jaminan bila nilai pinjaman mewajibkannya."
                />
              </Panel>

              <Panel
                as="h2"
                title="Langkah lanjutan"
                description="Hanya langkah yang sesuai status dokumen dan hak akses Anda yang bisa dibuka."
                footer={
                  <span>
                    Menu yang tidak muncul bukan pengaman. Server menolak permintaan yang sama
                    sekalipun alamatnya diketik langsung.
                  </span>
                }
              >
                <div className="aksi-list">
                  {lanjutan.map((aksi) => (
                    <Button
                      key={aksi.to}
                      variant="secondary"
                      disabled={!hasPermission(izin, aksi.izinPerlu as never)}
                      onClick={() => navigate(aksi.to)}
                    >
                      {aksi.label}
                    </Button>
                  ))}
                </div>
              </Panel>
            </>
          );
        }}
      </Muat>
      <CatatanOtorisasi tambahan="Pemisahan Maker, Checker, dan Approver ditegakkan di server dan oleh trigger basis data." />
    </PumkPage>
  );
}

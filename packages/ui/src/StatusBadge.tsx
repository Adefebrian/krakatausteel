// StatusBadge. One component for every enumerated state in the product, so
// "DISETUJUI" looks the same on the proposal list, the detail page, and the
// report. Label maps live here too, which keeps the Indonesian copy for a
// state in one place instead of in every page that renders it.
//
// State is never carried by color alone: the badge always shows its label.

export type BadgeTone = "neutral" | "progress" | "info" | "success" | "warning" | "caution" | "danger";

export interface StatusBadgeProps {
  /** The raw enum value from the API, e.g. "MENUNGGU_PERSETUJUAN". */
  status: string;
  /** Override the derived tone. Rarely needed. */
  tone?: BadgeTone;
  /** Override the derived label. Rarely needed. */
  label?: string;
}

/** Proposal PUMK state machine, spec 9.1. */
export const STATUS_PROPOSAL_PUMK: Record<string, { label: string; tone: BadgeTone }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  SURVEY_PENDING: { label: "Menunggu Survey", tone: "progress" },
  SURVEY_SELESAI: { label: "Survey Selesai", tone: "progress" },
  REVIEW_CHECKER: { label: "Review Checker", tone: "info" },
  MENUNGGU_PERSETUJUAN: { label: "Menunggu Persetujuan", tone: "info" },
  DISETUJUI: { label: "Disetujui", tone: "success" },
  TIDAK_DIREKOMENDASIKAN: { label: "Tidak Direkomendasikan", tone: "danger" },
  DITOLAK: { label: "Ditolak", tone: "danger" },
  AKAD_DIBUAT: { label: "Akad Dibuat", tone: "progress" },
  JADWAL_SIAP: { label: "Jadwal Siap", tone: "progress" },
  DICAIRKAN: { label: "Dicairkan", tone: "success" },
};

/** Proposal Non PUMK state machine, spec 9.2. */
export const STATUS_PROPOSAL_NON_PUMK: Record<string, { label: string; tone: BadgeTone }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  PENILAIAN: { label: "Penilaian", tone: "progress" },
  REVIEW_CHECKER: { label: "Review Checker", tone: "info" },
  MENUNGGU_PERSETUJUAN: { label: "Menunggu Persetujuan", tone: "info" },
  DISETUJUI: { label: "Disetujui", tone: "success" },
  DISALURKAN: { label: "Disalurkan", tone: "success" },
  MENUNGGU_LPJ: { label: "Menunggu LPJ", tone: "warning" },
  LPJ_DIAJUKAN: { label: "LPJ Diajukan", tone: "info" },
  LPJ_DITOLAK: { label: "LPJ Ditolak", tone: "danger" },
  SELESAI: { label: "Selesai", tone: "success" },
  TIDAK_DIREKOMENDASIKAN: { label: "Tidak Direkomendasikan", tone: "danger" },
  DITOLAK: { label: "Ditolak", tone: "danger" },
};

/** Kolektibilitas classes, spec 5.1. */
export const KOLEKTIBILITAS: Record<string, { label: string; tone: BadgeTone }> = {
  LANCAR: { label: "Lancar", tone: "success" },
  KURANG_LANCAR: { label: "Kurang Lancar", tone: "warning" },
  DIRAGUKAN: { label: "Diragukan", tone: "caution" },
  MACET: { label: "Macet", tone: "danger" },
};

/** Jurnal document states, spec 6.3. */
export const STATUS_JURNAL: Record<string, { label: string; tone: BadgeTone }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  VERIFIED: { label: "Terverifikasi", tone: "info" },
  POSTED: { label: "Posted", tone: "success" },
  REVERSED: { label: "Dibalik", tone: "caution" },
};

/** Periode states, spec 4.7. */
export const STATUS_PERIODE: Record<string, { label: string; tone: BadgeTone }> = {
  OPEN: { label: "Terbuka", tone: "success" },
  CLOSING_IN_PROGRESS: { label: "Proses Closing", tone: "warning" },
  CLOSED: { label: "Tertutup", tone: "neutral" },
};

/**
 * Where a shipped configuration default came from, spec 9.4's Parameter
 * Sistem. NOT a state and NOT a warning: it is a fact about the number's
 * provenance that stays true whatever the current value is.
 *
 * ASUMSI is the one that matters. It means nothing in the specification or in
 * the client's decisions proposes this figure and we invented it, which an
 * accountant reading a maximum grant value has no other way to find out. It is
 * toned as a quiet note rather than an alarm, because an assumption is not an
 * error: it is a number still waiting for the client's written confirmation.
 */
export const ASAL_NILAI: Record<string, { label: string; tone: BadgeTone }> = {
  SPEC: { label: "Dari spesifikasi", tone: "neutral" },
  KEPUTUSAN: { label: "Keputusan tercatat", tone: "info" },
  ASUMSI: { label: "Asumsi kami", tone: "warning" },
};

/** RKA states, spec 4.8. */
export const STATUS_RKA: Record<string, { label: string; tone: BadgeTone }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  DISETUJUI: { label: "Disetujui", tone: "success" },
  REVISI: { label: "Revisi", tone: "warning" },
};

const REGISTRY = [
  KOLEKTIBILITAS,
  ASAL_NILAI,
  STATUS_PROPOSAL_PUMK,
  STATUS_PROPOSAL_NON_PUMK,
  STATUS_JURNAL,
  STATUS_PERIODE,
  STATUS_RKA,
];

/**
 * Resolve an enum value to its Indonesian label and tone. Falls back to a
 * readable title-cased version of the raw value so an unmapped state from a
 * newer API still renders legibly instead of vanishing.
 */
export function resolveStatus(status: string): { label: string; tone: BadgeTone } {
  for (const map of REGISTRY) {
    const hit = map[status];
    if (hit) return hit;
  }
  const label = status
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return { label, tone: "neutral" };
}

export function StatusBadge({ status, tone, label }: StatusBadgeProps) {
  const resolved = resolveStatus(status);
  return (
    <span className={`badge badge-${tone ?? resolved.tone}`} data-status={status}>
      {label ?? resolved.label}
    </span>
  );
}

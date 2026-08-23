// Timeline. The approval trail spec 9.1 calls the most requested and most
// forgotten feature: who moved a document to which state, when, and with what
// note.
//
// Deliberately drawn without the usual vertical rail and marker dots: those
// are decorative connector lines and marker marks, banned by
// jal-frontend-rules. Order and grouping come from the step number, the
// hairline row divider, and the type hierarchy instead.
import type { ReactNode } from "react";
import { StatusBadge } from "./StatusBadge";

export interface TimelineEntry {
  id: string;
  /** The state the document moved INTO, e.g. "MENUNGGU_PERSETUJUAN". */
  status: string;
  /** Human action label, e.g. "Diajukan ke Checker". */
  action: string;
  /** Who did it. */
  actor: string;
  /** Their role at the time, e.g. "Maker". */
  actorRole?: string;
  /** Already formatted timestamp. The timeline does not own date policy. */
  at: string;
  /** Free text note recorded with the transition. */
  note?: string;
  extra?: ReactNode;
}

export interface TimelineProps {
  entries: readonly TimelineEntry[];
  /** Shown when the document has no recorded transition yet. */
  emptyLabel?: string;
  /** Newest first. Off by default, so a trail reads top to bottom. */
  reverse?: boolean;
}

export function Timeline({ entries, emptyLabel = "Belum ada riwayat persetujuan", reverse = false }: TimelineProps) {
  if (entries.length === 0) {
    return <p className="timeline-empty">{emptyLabel}</p>;
  }
  const ordered = reverse ? [...entries].reverse() : entries;

  return (
    <ol className="timeline">
      {ordered.map((entry, index) => (
        <li className="timeline-row" key={entry.id}>
          <span className="timeline-step" aria-hidden="true">
            {reverse ? ordered.length - index : index + 1}
          </span>
          <div className="timeline-body">
            <div className="timeline-head">
              <span className="timeline-action">{entry.action}</span>
              <StatusBadge status={entry.status} />
            </div>
            <p className="timeline-meta">
              {entry.actor}
              {entry.actorRole ? ` (${entry.actorRole})` : ""} pada {entry.at}
            </p>
            {entry.note ? <p className="timeline-note">{entry.note}</p> : null}
            {entry.extra}
          </div>
        </li>
      ))}
    </ol>
  );
}

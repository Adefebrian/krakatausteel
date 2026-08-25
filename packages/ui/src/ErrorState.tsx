// ErrorState. What a screen shows when the server could not answer.
//
// It exists so that a failure is never dressed up as data. There is no stub
// path and no sample row anywhere in this product: when a call fails, whatever
// the reason (the endpoint is not built yet, the database is down, the session
// scope refused the branch), the page renders THIS, says what it tried to do,
// shows the server's own sentence, and offers the retry. A reader can always
// tell "nothing came back" from "the answer is nothing".
//
// Deliberately not a toast: a toast disappears, and a page that quietly holds
// an empty table after the toast is gone is the exact lie this replaces.
import type { ReactNode } from "react";
import { Button } from "./Button";
import { Icon } from "./Icon";

export interface ErrorStateProps {
  /** What the page was trying to do, e.g. "Gagal memuat daftar proposal". */
  title: string;
  /** One sentence of what the reader can do about it. */
  description?: string;
  /** The server's own message, or the transport error. Shown verbatim. */
  detail?: string | null;
  /** Endpoint or operation that failed, for the person who has to chase it. */
  sumber?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
  /** Extra action, e.g. a link back to the list. */
  action?: ReactNode;
}

export function ErrorState({
  title,
  description = "Data pada bagian ini tidak ditampilkan karena server tidak memberi jawaban. Tidak ada angka yang dikira kira di halaman ini.",
  detail,
  sumber,
  onRetry,
  retryLabel = "Coba lagi",
  action,
}: ErrorStateProps) {
  return (
    <div className="errorstate" role="alert">
      <span className="errorstate-icon" aria-hidden="true">
        <Icon name="alert" size={20} />
      </span>
      <div className="errorstate-body">
        <p className="errorstate-title">{title}</p>
        <p className="errorstate-desc">{description}</p>
        {detail ? <p className="errorstate-detail">{detail}</p> : null}
        {sumber ? <p className="errorstate-source">Sumber data: {sumber}</p> : null}
        {onRetry || action ? (
          <div className="errorstate-actions">
            {onRetry ? (
              <Button variant="secondary" size="sm" onClick={onRetry} leading={<Icon name="refresh" size={16} />}>
                {retryLabel}
              </Button>
            ) : null}
            {action}
          </div>
        ) : null}
      </div>
    </div>
  );
}

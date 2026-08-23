// Modal. Presentational dialog over a scrim, elevation-3 because it is the
// one place in the product where something genuinely stacks above content.
//
// Keeps the small accessibility contract a hand-rolled dialog needs: labelled
// by its own title, Escape closes, focus moves into the panel on open and
// returns to the trigger on close, and a click on the scrim closes.
import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";

export interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  /** Footer actions, usually a cancel plus a primary button. */
  actions?: ReactNode;
  size?: "sm" | "md" | "lg";
  children: ReactNode;
  closeLabel?: string;
}

export function Modal({
  open,
  title,
  description,
  onClose,
  actions,
  size = "md",
  children,
  closeLabel = "Tutup",
}: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<Element | null>(null);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement;
    document.addEventListener("keydown", handleKeyDown);
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      const target = returnFocusRef.current;
      if (target instanceof HTMLElement) target.focus();
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div
        className={`modal modal-${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        ref={panelRef}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2 className="modal-title" id={titleId}>
              {title}
            </h2>
            {description ? (
              <p className="modal-desc" id={descriptionId}>
                {description}
              </p>
            ) : null}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={closeLabel}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {actions ? <div className="modal-foot">{actions}</div> : null}
      </div>
    </div>
  );
}

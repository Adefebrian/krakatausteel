// ConfirmDialog. The one confirmation step in the product.
//
// Every irreversible action goes through it: posting a disbursement, writing
// off a receivable, ending an akad, removing a mitra from a cluster. The
// dialog states WHAT WILL HAPPEN in plain Indonesian, and for the actions that
// cannot be undone it also requires the operator to type a phrase, so a
// destructive click cannot be a reflex on a muscle-memory Enter.
//
// It never claims the system moves money. The copy a caller passes describes
// what is RECORDED, because this application books events that already
// happened outside it.
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "./Button";
import { Field, TextInput } from "./FormField";
import { Modal } from "./Modal";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** One sentence naming exactly what the confirm button will record. */
  description?: string;
  /** The detail of what is about to be recorded, usually a DataList. */
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** "danger" for anything irreversible. */
  tone?: "primary" | "danger";
  /**
   * When set, the confirm button stays disabled until the operator types this
   * exact phrase. Reserve it for the irreversible actions.
   */
  confirmPhrase?: string;
  confirmPhraseLabel?: string;
  loading?: boolean;
  /** Shown inside the dialog when the action itself failed. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = "Batal",
  tone = "primary",
  confirmPhrase,
  confirmPhraseLabel = "Ketik untuk mengonfirmasi",
  loading = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");

  // Reset between openings, so a phrase typed for one document cannot arm the
  // confirm button for the next one.
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);

  const armed = !confirmPhrase || typed.trim() === confirmPhrase;

  return (
    <Modal
      open={open}
      title={title}
      description={description}
      onClose={onCancel}
      size="sm"
      actions={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={!armed}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {confirmPhrase ? (
        <div className="confirm-phrase">
          <Field
            label={confirmPhraseLabel}
            hint={`Ketik persis: ${confirmPhrase}`}
            htmlFor="confirm-phrase-input"
          >
            <TextInput
              id="confirm-phrase-input"
              value={typed}
              autoComplete="off"
              onChange={(event) => setTyped(event.currentTarget.value)}
            />
          </Field>
        </div>
      ) : null}
      {error ? (
        <p className="confirm-error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

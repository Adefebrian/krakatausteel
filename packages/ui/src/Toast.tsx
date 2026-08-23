// Toast. The product's single "the action landed" channel, so a save, a
// posting, or a rejected authorization is never answered with silence.
//
// Dependency-light: React context and a timer, no notification library. The
// live region is polite for success and assertive for an error, so a screen
// reader hears a failure immediately without being interrupted by a save
// confirmation.
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon, type IconName } from "./Icon";

export type ToastTone = "success" | "error" | "info";

export interface ToastMessage {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
}

export interface ToastApi {
  show: (toast: Omit<ToastMessage, "id">) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONE_ICON: Record<ToastTone, IconName> = {
  success: "check",
  error: "alert",
  info: "info",
};

const DEFAULT_TTL_MS = 5000;

export interface ToastProviderProps {
  children: ReactNode;
  /** Auto dismiss delay. Errors stay until dismissed. */
  ttlMs?: number;
}

export function ToastProvider({ children, ttlMs = DEFAULT_TTL_MS }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (toast: Omit<ToastMessage, "id">) => {
      counter.current += 1;
      const id = `toast-${counter.current}`;
      setToasts((current) => [...current, { ...toast, id }]);
      if (toast.tone !== "error") {
        setTimeout(() => dismiss(id), ttlMs);
      }
    },
    [dismiss, ttlMs],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (title, description) => show({ tone: "success", title, description }),
      error: (title, description) => show({ tone: "error", title, description }),
      info: (title, description) => show({ tone: "info", title, description }),
      dismiss,
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast dipakai di luar ToastProvider");
  return api;
}

export interface ToastViewportProps {
  toasts: readonly ToastMessage[];
  onDismiss: (id: string) => void;
}

export function ToastViewport({ toasts, onDismiss }: ToastViewportProps) {
  return (
    <div className="toast-viewport">
      <div aria-live="polite" aria-atomic="false" className="toast-stack">
        {toasts
          .filter((toast) => toast.tone !== "error")
          .map((toast) => (
            <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
          ))}
      </div>
      <div aria-live="assertive" aria-atomic="false" className="toast-stack">
        {toasts
          .filter((toast) => toast.tone === "error")
          .map((toast) => (
            <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
          ))}
      </div>
    </div>
  );
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: ToastMessage;
  onDismiss: (id: string) => void;
}) {
  return (
    <div className={`toast toast-${toast.tone}`} role="status">
      <Icon name={TONE_ICON[toast.tone]} size={18} />
      <div className="toast-body">
        <p className="toast-title">{toast.title}</p>
        {toast.description ? <p className="toast-desc">{toast.description}</p> : null}
      </div>
      <button
        type="button"
        className="icon-btn"
        onClick={() => onDismiss(toast.id)}
        aria-label="Tutup notifikasi"
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

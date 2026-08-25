// The two hooks every PUMK screen reads and writes through.
//
// `useApi` is a read: four honest states and no fifth. There is no "stale
// data" state and no cache, because a screen in this product must never show
// a figure whose provenance the reader cannot name.
//
//   "memuat"  in flight
//   "siap"    the server answered, `data` is what it said
//   "gagal"   it did not, `error` is why, and NOTHING is rendered as data
//   "diam"    deliberately not requested yet (no document selected)
//
// `useAction` is a write: idle, pending, failed, done. It never optimistically
// applies the change, for the reason ../session.tsx does not optimistically
// log out: if the request did not land, the record did not change, and drawing
// the screen as though it had is a lie the operator will act on.
import { useCallback, useEffect, useRef, useState } from "react";
import { pesanKesalahan, UnauthorizedError } from "./http";

export type StatusMuat = "diam" | "memuat" | "siap" | "gagal";

export interface HasilApi<T> {
  status: StatusMuat;
  data: T | null;
  error: string | null;
  reload: () => void;
}

export interface OpsiApi {
  /** False parks the hook in "diam", e.g. before a document is chosen. */
  enabled?: boolean;
}

export function useApi<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[],
  opsi: OpsiApi = {},
): HasilApi<T> {
  const enabled = opsi.enabled ?? true;
  const [status, setStatus] = useState<StatusMuat>(enabled ? "memuat" : "diam");
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!enabled) {
      setStatus("diam");
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setStatus("memuat");
    setError(null);
    fetcherRef
      .current()
      .then((value) => {
        if (cancelled) return;
        setData(value);
        setStatus("siap");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // A dead session is the session provider's business, not this
        // screen's: it re-renders the login form on the next revalidation.
        // Showing "Sesi tidak valid" as a red panel on a table would send the
        // user looking for a data problem that is not there.
        if (cause instanceof UnauthorizedError) return;
        setData(null);
        setError(pesanKesalahan(cause));
        setStatus("gagal");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, attempt, ...deps]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { status, data, error, reload };
}

export type StatusAksi = "diam" | "mengirim" | "selesai" | "gagal";

export interface HasilAksi<Input, Output> {
  status: StatusAksi;
  error: string | null;
  hasil: Output | null;
  jalankan: (input: Input) => Promise<Output | null>;
  reset: () => void;
}

export function useAction<Input, Output>(
  action: (input: Input) => Promise<Output>,
): HasilAksi<Input, Output> {
  const [status, setStatus] = useState<StatusAksi>("diam");
  const [error, setError] = useState<string | null>(null);
  const [hasil, setHasil] = useState<Output | null>(null);
  const actionRef = useRef(action);
  actionRef.current = action;
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const jalankan = useCallback(async (input: Input) => {
    setStatus("mengirim");
    setError(null);
    try {
      const value = await actionRef.current(input);
      if (!alive.current) return value;
      setHasil(value);
      setStatus("selesai");
      return value;
    } catch (cause: unknown) {
      if (!alive.current) return null;
      setHasil(null);
      setError(pesanKesalahan(cause));
      setStatus("gagal");
      return null;
    }
  }, []);

  const reset = useCallback(() => {
    setStatus("diam");
    setError(null);
    setHasil(null);
  }, []);

  return { status, error, hasil, jalankan, reset };
}

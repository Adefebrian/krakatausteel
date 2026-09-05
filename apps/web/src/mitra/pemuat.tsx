// The four load states, once, for the mitra area.
//
// A SECOND COPY OF THE SAME IDEA AS ../pages/shared/parts.tsx's `Muat`, and
// deliberately not that one: `Muat` renders the staff `ErrorState`, and the two
// surfaces must be able to change independently. This one also knows something
// the staff version does not, and it is the reason it exists at all: a 401 on
// this surface is not an error, it is the session ending, and the honest answer
// is the mitra login form rather than a red panel telling a borrower to call
// somebody.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Icon } from "@krakatausteel/ui";
import { MitraTidakMasuk } from "../api/mitra";
import { useSesiMitra } from "./sesi";

export type StatusMuat = "memuat" | "siap" | "gagal";

export interface HasilMuat<T> {
  status: StatusMuat;
  data: T | null;
  error: string | null;
  ulangi: () => void;
}

/**
 * One read, with its own state.
 *
 * `ulangi` re-runs the read; it does not merely clear the error, because an
 * error that could be dismissed without retrying leaves a blank card behind and
 * makes a reader think the answer was empty.
 */
export function useMuatMitra<T>(ambil: () => Promise<T>, deps: readonly unknown[]): HasilMuat<T> {
  const { ulangi: ulangiSesi } = useSesiMitra();
  const [status, setStatus] = useState<StatusMuat>("memuat");
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [percobaan, setPercobaan] = useState(0);

  useEffect(() => {
    let dibatalkan = false;
    setStatus("memuat");
    ambil()
      .then((nilai) => {
        if (dibatalkan) return;
        setData(nilai);
        setError(null);
        setStatus("siap");
      })
      .catch((penyebab: unknown) => {
        if (dibatalkan) return;
        if (penyebab instanceof MitraTidakMasuk) {
          // The session ended under the page. Hand it back to the bootstrap,
          // which renders the login form; showing an error panel here would
          // leave the reader with nothing to press.
          ulangiSesi();
          return;
        }
        setData(null);
        setError(penyebab instanceof Error ? penyebab.message : "Terjadi kesalahan tak terduga.");
        setStatus("gagal");
      });
    return () => {
      dibatalkan = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, percobaan]);

  const ulangi = useCallback(() => setPercobaan((n) => n + 1), []);
  return { status, data, error, ulangi };
}

export function Muat<T>({
  hasil,
  judul,
  children,
}: {
  hasil: HasilMuat<T>;
  /** What was being loaded, e.g. "daftar akad Anda". */
  judul: string;
  children: (data: T) => ReactNode;
}) {
  if (hasil.status === "memuat") {
    return (
      <p className="mitra-muat" role="status">
        Memuat {judul}.
      </p>
    );
  }
  if (hasil.status === "gagal" || hasil.data === null) {
    return (
      <div className="mitra-muat-gagal" role="alert">
        <p className="mitra-muat-gagal-judul">
          <Icon name="alert" size={16} />
          <span>Gagal memuat {judul}</span>
        </p>
        <p className="mitra-muat-gagal-teks">{hasil.error}</p>
        <button type="button" className="mitra-btn is-utama" onClick={hasil.ulangi}>
          Coba lagi
        </button>
      </div>
    );
  }
  return <>{children(hasil.data)}</>;
}

/** Nothing to show, and why. Never an empty card with no words in it. */
export function KosongMitra({ judul, pesan }: { judul: string; pesan: string }) {
  return (
    <div className="mitra-kosong">
      <span className="mitra-kosong-ikon" aria-hidden="true">
        <Icon name="list" size={20} />
      </span>
      <p className="mitra-kosong-judul">{judul}</p>
      <p className="mitra-kosong-teks">{pesan}</p>
    </div>
  );
}

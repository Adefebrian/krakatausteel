// The MITRA session. A second, separate bootstrap, deliberately not
// ../session.tsx.
//
// ADR 0019: "A mitra is a second principal, not a role on app_user." The server
// gives the two principals different cookies, different stores, different
// guards and a principal type with no field in common, because one mechanism
// means one bug turns one principal into the other. Reusing `useSession` here
// would put that single mechanism back: one context, one status machine, one
// login screen, and a borrower one bug away from being handed a staff shell.
//
// FOUR STATES, THE SAME FOUR THE STAFF BOOTSTRAP HAS AND FOR THE SAME REASONS,
// PLUS ONE THIS SURFACE ALONE NEEDS:
//
//   "memuat"  the profile request is in flight
//   "keluar"  a real 401, render the mitra login form with no error on it
//   "masuk"   a live session
//   "ganti"   a live session that may do exactly ONE thing: replace the
//             password an officer handed over. The server holds it there too
//             (`wajibSandiSendiri`), so this is the screen agreeing with the
//             server rather than deciding anything.
//   "gagal"   the API could not be reached. NOT the same as "keluar": telling
//             a mitra their password failed when the server is down sends them
//             to a branch office over nothing.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  gantiSandi as gantiSandiRequest,
  keluar as keluarRequest,
  masuk as masukRequest,
  MitraTidakMasuk,
  MitraTidakTerhubung,
  MitraWajibGantiSandi,
  profil as profilRequest,
  type ProfilMitra,
} from "../api/mitra";

export type StatusMitra = "memuat" | "keluar" | "masuk" | "ganti" | "gagal";

export interface SesiMitra {
  status: StatusMitra;
  profil: ProfilMitra | null;
  error: string | null;
  masuk: (email: string, sandi: string) => Promise<void>;
  keluar: () => Promise<void>;
  gantiSandi: (sandiLama: string, sandiBaru: string) => Promise<void>;
  ulangi: () => void;
}

const KonteksMitra = createContext<SesiMitra | null>(null);

export function PenyediaSesiMitra({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<StatusMitra>("memuat");
  const [profil, setProfil] = useState<ProfilMitra | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [percobaan, setPercobaan] = useState(0);

  useEffect(() => {
    let dibatalkan = false;
    setStatus("memuat");
    profilRequest()
      .then((nilai) => {
        if (dibatalkan) return;
        setProfil(nilai);
        setError(null);
        setStatus(nilai.harusGantiSandi ? "ganti" : "masuk");
      })
      .catch((penyebab: unknown) => {
        if (dibatalkan) return;
        setProfil(null);
        if (penyebab instanceof MitraTidakMasuk) {
          // Not signed in. The honest answer is the form, with no error on it.
          setError(null);
          setStatus("keluar");
          return;
        }
        if (penyebab instanceof MitraWajibGantiSandi) {
          // A live session that the server is holding at the password screen.
          // The profile could not be read because of it, so the screen carries
          // the reason and nothing else.
          setError(penyebab.message);
          setStatus("ganti");
          return;
        }
        setError(
          penyebab instanceof MitraTidakTerhubung
            ? penyebab.message
            : penyebab instanceof Error
              ? penyebab.message
              : "Terjadi kesalahan tak terduga.",
        );
        setStatus("gagal");
      });
    return () => {
      dibatalkan = true;
    };
  }, [percobaan]);

  const masuk = useCallback(async (email: string, sandi: string) => {
    const hasil = await masukRequest(email, sandi);
    setProfil(hasil.profil);
    setError(null);
    setStatus(hasil.harusGantiSandi ? "ganti" : "masuk");
  }, []);

  const keluar = useCallback(async () => {
    await keluarRequest();
    setProfil(null);
    setError(null);
    setStatus("keluar");
  }, []);

  const gantiSandi = useCallback(async (sandiLama: string, sandiBaru: string) => {
    await gantiSandiRequest(sandiLama, sandiBaru);
    // The server has cleared `harus_ganti_sandi`, so the profile is re-read
    // rather than patched here: the screen must not decide it is now allowed
    // in, the server's answer must.
    const nilai = await profilRequest();
    setProfil(nilai);
    setError(null);
    setStatus(nilai.harusGantiSandi ? "ganti" : "masuk");
  }, []);

  const ulangi = useCallback(() => setPercobaan((n) => n + 1), []);

  const value = useMemo<SesiMitra>(
    () => ({ status, profil, error, masuk, keluar, gantiSandi, ulangi }),
    [status, profil, error, masuk, keluar, gantiSandi, ulangi],
  );

  return <KonteksMitra.Provider value={value}>{children}</KonteksMitra.Provider>;
}

export function useSesiMitra(): SesiMitra {
  const value = useContext(KonteksMitra);
  if (!value) throw new Error("useSesiMitra dipakai di luar PenyediaSesiMitra");
  return value;
}

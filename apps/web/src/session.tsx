// Session bootstrap. One place decides whether the app renders the login
// screen or the shell, and it decides on the server's answer, never on a guess.
//
// State machine:
//   "memuat"   the session request is in flight, render the boot screen
//   "keluar"   no valid session (a real 401), render the login screen
//   "masuk"    a session exists, render the shell
//   "gagal"    the API could not be reached, render the retry screen. This is
//              deliberately NOT the same as "keluar": telling a user their
//              credentials failed when the server is down sends them chasing
//              the wrong problem.
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
  ApiUnreachableError,
  fetchSession,
  login as loginRequest,
  logout as logoutRequest,
  UnauthorizedError,
  type Session,
} from "./api/auth";

export type SessionStatus = "memuat" | "keluar" | "masuk" | "gagal";

export interface SessionValue {
  status: SessionStatus;
  session: Session | null;
  /** Set when status is "gagal". */
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  retry: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>("memuat");
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus("memuat");
    fetchSession()
      .then((value) => {
        if (cancelled) return;
        setSession(value);
        setError(null);
        setStatus("masuk");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setSession(null);
        if (cause instanceof UnauthorizedError) {
          setError(null);
          setStatus("keluar");
          return;
        }
        setError(
          cause instanceof ApiUnreachableError ? cause.message : "Terjadi kesalahan tak terduga",
        );
        setStatus("gagal");
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const login = useCallback(async (username: string, password: string) => {
    const value = await loginRequest(username, password);
    setSession(value);
    setError(null);
    setStatus("masuk");
  }, []);

  const logout = useCallback(async () => {
    await logoutRequest();
    setSession(null);
    setError(null);
    setStatus("keluar");
  }, []);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const value = useMemo<SessionValue>(
    () => ({ status, session, error, login, logout, retry }),
    [status, session, error, login, logout, retry],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession dipakai di luar SessionProvider");
  return value;
}

/** Convenience for a page that only renders inside the shell. */
export function useActiveSession(): Session {
  const { session } = useSession();
  if (!session) throw new Error("Tidak ada sesi aktif");
  return session;
}

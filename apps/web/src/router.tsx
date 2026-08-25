// Hand rolled client side router. No react-router, no Next.js: the History
// API plus one subscription is the whole implementation, and apps/web/server.ts
// already serves index.html for any deep link so a refresh on /pumk/proposal
// works.
//
// Routes are looked up in the nav table in ./nav.ts: an exact path first, then
// a single-segment `:param` pattern (see `findRoute` there). Fase 3 needs
// those, because a proposal detail page and a Kartu Piutang are per document
// and have to survive a refresh and a pasted link.
//
// The query string is tracked separately from the path. Route matching only
// ever reads the path, so a filter or a selected document in the query can
// never change which page renders, while a deep link like
// /pumk/persetujuan?proposal=... still opens the right document.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type ReactNode,
} from "react";

export interface RouterValue {
  path: string;
  /** The raw query string, including the leading "?", or "". */
  search: string;
  /** Parsed query. Read only: navigate to change it. */
  query: URLSearchParams;
  navigate: (to: string, options?: { replace?: boolean }) => void;
  /** Rewrite one query parameter on the current path, replacing history. */
  setQuery: (key: string, value: string | null) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

function currentPath(): string {
  const raw = globalThis.location?.pathname ?? "/";
  return raw.length > 1 && raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function currentSearch(): string {
  return globalThis.location?.search ?? "";
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(currentPath);
  const [search, setSearch] = useState(currentSearch);

  useEffect(() => {
    const onPopState = () => {
      setPath(currentPath());
      setSearch(currentSearch());
    };
    globalThis.addEventListener("popstate", onPopState);
    return () => globalThis.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((to: string, options?: { replace?: boolean }) => {
    // Compared with the query included: /pumk/persetujuan?proposal=A and
    // ?proposal=B are different destinations even though the path is one path.
    if (to === `${currentPath()}${currentSearch()}`) return;
    if (options?.replace) globalThis.history.replaceState(null, "", to);
    else globalThis.history.pushState(null, "", to);
    setPath(currentPath());
    setSearch(currentSearch());
    globalThis.scrollTo?.({ top: 0 });
  }, []);

  const setQuery = useCallback((key: string, value: string | null) => {
    const next = new URLSearchParams(currentSearch());
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
    const rendered = next.toString();
    const to = rendered === "" ? currentPath() : `${currentPath()}?${rendered}`;
    globalThis.history.replaceState(null, "", to);
    setSearch(currentSearch());
  }, []);

  const value = useMemo<RouterValue>(
    () => ({ path, search, query: new URLSearchParams(search), navigate, setQuery }),
    [path, search, navigate, setQuery],
  );
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error("useRouter dipakai di luar RouterProvider");
  return value;
}

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  to: string;
  children: ReactNode;
}

export function Link({ to, children, onClick, ...rest }: LinkProps) {
  const { navigate } = useRouter();
  return (
    <a
      {...rest}
      href={to}
      onClick={(event) => {
        onClick?.(event);
        // Let the browser handle a new tab, a download, or a modified click.
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

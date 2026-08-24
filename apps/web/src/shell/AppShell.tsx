// App shell.
//
// Desktop and tablet: a full width top bar over a two column body, the left
// column being the navigation with its own scroll, the right column the page.
// Mobile: the app shell pattern from jal-frontend-rules, a sticky header with
// safe-area-inset-top, an independently scrolling content region, and a fixed
// bottom tab bar with safe-area-inset-bottom. The full navigation lives in a
// sheet behind the tab bar's last tab.
//
// The top bar carries the four things a user needs at all times: the app name,
// the active cabang, the active periode, and their own account.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, formatPeriode, useToast, type IconName } from "@krakatausteel/ui";
import { namaRole } from "../permissions";
import { hasPermission } from "../permissions";
import { findRoute } from "../nav";
import { Link, useRouter } from "../router";
import { useSession } from "../session";
import { SideNav } from "./SideNav";

interface Tab {
  label: string;
  icon: IconName;
  path: string;
  /** Active when the current path starts with one of these prefixes. */
  match: readonly string[];
}

// Four tabs plus the Menu tab, which is the ceiling that keeps every label on
// one line at 320px. Non PUMK is deliberately not a tab: it is one tap away in
// the Menu sheet, and a fifth label truncates to "Non P..." at this width.
const TABS: readonly Tab[] = [
  { label: "Dashboard", icon: "dashboard", path: "/", match: ["/"] },
  { label: "PUMK", icon: "pumk", path: "/pumk/proposal", match: ["/pumk"] },
  { label: "Laporan", icon: "laporan", path: "/laporan/akuntansi", match: ["/laporan"] },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { session, logout } = useSession();
  const { path, navigate } = useRouter();
  const toast = useToast();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    setSheetOpen(false);
    setMenuOpen(false);
  }, [path]);

  // Logging out is a server side action: the Redis session has to actually be
  // destroyed. If the request never lands, the session is still live, so the
  // user is told instead of being shown a login screen that would be a lie.
  async function keluar() {
    try {
      await logout();
    } catch {
      toast.error(
        "Gagal keluar",
        "Server tidak dapat dihubungi, jadi sesi Anda belum ditutup. Coba lagi.",
      );
    }
  }

  if (!session) return null;

  const permissions = session.permissions;
  const tabs = TABS.filter((tab) => {
    const route = findRoute(tab.path);
    return route ? hasPermission(permissions, route.permission) : false;
  });

  return (
    <div className="shell">
      <header className="shell-topbar">
        <div className="shell-topbar-main">
          <button
            type="button"
            className="icon-btn shell-drawer-btn"
            aria-label="Buka navigasi"
            aria-expanded={sheetOpen}
            onClick={() => setSheetOpen(true)}
          >
            <Icon name="menu" size={20} />
          </button>

          <Link to="/" className="shell-brand">
            <span className="shell-mark" aria-hidden="true">
              <Icon name="pumk" size={18} />
            </span>
            <span className="shell-brand-name">TJSL Online</span>
          </Link>

          <div className="shell-context is-inline">
            <ContextChips
              cabang={`${session.cabang.kode} ${session.cabang.nama}`}
              periode={formatPeriode(session.periode.tahun, session.periode.bulan)}
              periodeStatus={session.periode.status}
            />
          </div>

          <div className="shell-user" ref={menuRef}>
            <button
              type="button"
              className={menuOpen ? "shell-user-btn is-open" : "shell-user-btn"}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              onClick={() => setMenuOpen((value) => !value)}
            >
              <span className="shell-avatar" aria-hidden="true">
                <Icon name="user" size={16} />
              </span>
              <span className="shell-user-text">
                <span className="shell-user-name">{session.user.nama}</span>
                <span className="shell-user-role">{namaRole(session.user.role)}</span>
              </span>
              <Icon name="chevronDown" size={16} />
            </button>
            {menuOpen ? (
              <div className="shell-menu" role="menu">
                <p className="shell-menu-line">
                  <span className="shell-menu-key">Nama pengguna</span>
                  <span className="shell-menu-val">{session.user.username}</span>
                </p>
                <p className="shell-menu-line">
                  <span className="shell-menu-key">Role</span>
                  <span className="shell-menu-val">{namaRole(session.user.role)}</span>
                </p>
                <p className="shell-menu-line">
                  <span className="shell-menu-key">Cabang</span>
                  <span className="shell-menu-val">{session.cabang.nama}</span>
                </p>
                <p className="shell-menu-line">
                  <span className="shell-menu-key">Periode aktif</span>
                  <span className="shell-menu-val">
                    {formatPeriode(session.periode.tahun, session.periode.bulan)}
                  </span>
                </p>
                <button
                  type="button"
                  className="shell-menu-action"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    void keluar();
                  }}
                >
                  <Icon name="logout" size={16} />
                  <span>Keluar</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="shell-context is-strip">
          <ContextChips
            cabang={`${session.cabang.kode} ${session.cabang.nama}`}
            periode={formatPeriode(session.periode.tahun, session.periode.bulan)}
            periodeStatus={session.periode.status}
          />
        </div>
      </header>

      <div className="shell-body">
        <aside className="shell-side">
          <SideNav permissions={permissions} />
        </aside>
        <main className="shell-content" id="konten">
          {children}
        </main>
      </div>

      {sheetOpen ? (
        <div className="shell-sheet" role="dialog" aria-modal="true" aria-label="Navigasi">
          <div className="shell-sheet-head">
            <span className="shell-sheet-title">Navigasi</span>
            <button
              type="button"
              className="icon-btn"
              aria-label="Tutup navigasi"
              onClick={() => setSheetOpen(false)}
            >
              <Icon name="close" size={20} />
            </button>
          </div>
          <div className="shell-sheet-body">
            <SideNav permissions={permissions} onNavigate={() => setSheetOpen(false)} />
            <div className="shell-sheet-account">
              <p className="shell-menu-line">
                <span className="shell-menu-key">Pengguna</span>
                <span className="shell-menu-val">{session.user.nama}</span>
              </p>
              <p className="shell-menu-line">
                <span className="shell-menu-key">Role</span>
                <span className="shell-menu-val">{namaRole(session.user.role)}</span>
              </p>
              <p className="shell-menu-line">
                <span className="shell-menu-key">Cabang</span>
                <span className="shell-menu-val">{session.cabang.nama}</span>
              </p>
              <p className="shell-menu-line">
                <span className="shell-menu-key">Periode aktif</span>
                <span className="shell-menu-val">
                  {formatPeriode(session.periode.tahun, session.periode.bulan)}
                </span>
              </p>
              <button
                type="button"
                className="shell-menu-action"
                onClick={() => {
                  setSheetOpen(false);
                  void keluar();
                }}
              >
                <Icon name="logout" size={16} />
                <span>Keluar</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <nav className="shell-tabbar" aria-label="Navigasi cepat">
        {tabs.map((tab) => {
          const active =
            tab.path === "/" ? path === "/" : tab.match.some((prefix) => path.startsWith(prefix));
          return (
            <button
              key={tab.path}
              type="button"
              className={active ? "tab is-active" : "tab"}
              aria-current={active ? "page" : undefined}
              onClick={() => navigate(tab.path)}
            >
              <Icon name={tab.icon} size={20} />
              <span>{tab.label}</span>
            </button>
          );
        })}
        <button
          type="button"
          className={sheetOpen ? "tab is-active" : "tab"}
          aria-expanded={sheetOpen}
          onClick={() => setSheetOpen((value) => !value)}
        >
          <Icon name="menu" size={20} />
          <span>Menu</span>
        </button>
      </nav>
    </div>
  );
}

function ContextChips({
  cabang,
  periode,
  periodeStatus,
}: {
  cabang: string;
  periode: string;
  periodeStatus: string;
}) {
  const statusLabel =
    periodeStatus === "OPEN"
      ? "Terbuka"
      : periodeStatus === "CLOSING_IN_PROGRESS"
        ? "Proses closing"
        : "Tertutup";
  return (
    <>
      <span className="chip">
        <Icon name="building" size={14} />
        <span className="chip-key">Cabang</span>
        <span className="chip-val">{cabang}</span>
      </span>
      <span className="chip">
        <Icon name="calendar" size={14} />
        <span className="chip-key">Periode</span>
        <span className="chip-val">{periode}</span>
        <span className="chip-status">{statusLabel}</span>
      </span>
    </>
  );
}

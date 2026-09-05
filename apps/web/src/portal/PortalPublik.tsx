// THE PUBLIC PORTAL (spec 9.5). The only part of this product a member of the
// public ever sees.
//
// IT IS NOT THE STAFF APP WITH THE NAVIGATION HIDDEN. It has its own shell, its
// own header, its own three destinations and its own transport
// (../api/portal-publik.ts, which sends no cookie at all). It renders BEFORE
// ../session.tsx is ever mounted, so a visitor here never triggers a session
// request, never sees a staff login screen, and never has a staff cookie
// attached to their application. ADR 0019 makes the same split on the server;
// this is the frontend refusing to reunify what the server deliberately kept
// apart.
//
// THERE IS NO LINK INTO THE STAFF APP FROM ANY PAGE HERE. Not in the header,
// not in the footer, not in the help page. An officer types the address; a
// member of the public has no reason to be told it exists.
//
// THREE DESTINATIONS, AND THAT IS THE WHOLE SURFACE: apply, check a ticket, and
// what to do when neither of those helps. On a phone they are a fixed bottom
// tab bar; on a desk they are a segmented control in the header. The same three
// either way, so the two layouts are one product.
import { useEffect, useState, type ReactNode } from "react";
import { Icon, type IconName } from "@krakatausteel/ui";
import { useRouter } from "../router";
import { Bantuan } from "./Bantuan";
import { CekStatus } from "./CekStatus";
import { Pengajuan } from "./Pengajuan";

export const JALUR_PORTAL = ["/pengajuan", "/cek-status", "/bantuan"] as const;

/** True for a path the public portal owns. Read by ../App.tsx before anything
 *  else, which is what keeps the staff session out of this surface entirely. */
export function adalahJalurPortal(path: string): boolean {
  return JALUR_PORTAL.some((jalur) => path === jalur || path.startsWith(`${jalur}/`));
}

interface Tujuan {
  path: (typeof JALUR_PORTAL)[number];
  label: string;
  /** The heading the page itself carries, spelled once. */
  judul: string;
  icon: IconName;
}

const TUJUAN: readonly Tujuan[] = [
  { path: "/pengajuan", label: "Ajukan", judul: "Ajukan Permohonan", icon: "file" },
  { path: "/cek-status", label: "Cek Status", judul: "Cek Status Pengajuan", icon: "search" },
  { path: "/bantuan", label: "Bantuan", judul: "Bantuan", icon: "info" },
];

export function PortalPublik() {
  const { path, navigate } = useRouter();
  const aktif = TUJUAN.find((t) => path === t.path || path.startsWith(`${t.path}/`)) ?? TUJUAN[0]!;

  // The public portal is one document per destination, so the tab title has to
  // follow the destination or a shared bookmark is named after whatever page
  // happened to load first.
  useEffect(() => {
    document.title = `${aktif.judul} - TJSL Online`;
  }, [aktif.judul]);

  return (
    <div className="publik-shell">
      <header className="publik-topbar">
        <div className="publik-topbar-row">
          <span className="publik-brand">
            <span className="publik-mark" aria-hidden="true">
              <Icon name="handshake" size={18} />
            </span>
            <span className="publik-brand-name">Portal TJSL Online</span>
          </span>
          <nav className="publik-nav" aria-label="Halaman portal">
            {TUJUAN.map((tujuan) => (
              <button
                key={tujuan.path}
                type="button"
                className={tujuan.path === aktif.path ? "publik-nav-btn is-active" : "publik-nav-btn"}
                aria-current={tujuan.path === aktif.path ? "page" : undefined}
                onClick={() => navigate(tujuan.path)}
              >
                {tujuan.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="publik-main" id="isi">
        <div className="publik-lebar">
          {aktif.path === "/pengajuan" ? <Pengajuan /> : null}
          {aktif.path === "/cek-status" ? <CekStatus /> : null}
          {aktif.path === "/bantuan" ? <Bantuan /> : null}
        </div>
      </main>

      <nav className="publik-tabbar" aria-label="Navigasi portal">
        {TUJUAN.map((tujuan) => (
          <button
            key={tujuan.path}
            type="button"
            className={tujuan.path === aktif.path ? "publik-tab is-active" : "publik-tab"}
            aria-current={tujuan.path === aktif.path ? "page" : undefined}
            onClick={() => navigate(tujuan.path)}
          >
            <Icon name={tujuan.icon} size={20} />
            <span className="publik-tab-label">{tujuan.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

/**
 * The page frame every public screen sits in, so the three of them cannot grow
 * three different headings, three paddings and three rhythms.
 */
export function HalamanPublik({
  judul,
  ringkas,
  children,
}: {
  judul: string;
  ringkas: string;
  children: ReactNode;
}) {
  return (
    <div className="publik-page">
      <header className="publik-page-head">
        <h1 className="publik-page-title">{judul}</h1>
        <p className="publik-page-sub">{ringkas}</p>
      </header>
      {children}
    </div>
  );
}

/**
 * A card on a public page. Same chrome as the staff Panel, restated here
 * rather than imported so a change to the staff card cannot silently reshape
 * the one surface the public sees.
 */
export function KartuPublik({
  judul,
  ringkas,
  children,
  footer,
}: {
  judul: string;
  ringkas?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className="publik-kartu">
      <div className="publik-kartu-head">
        <h2 className="publik-kartu-judul">{judul}</h2>
        {ringkas ? <p className="publik-kartu-sub">{ringkas}</p> : null}
      </div>
      <div className="publik-kartu-body">{children}</div>
      {footer ? <div className="publik-kartu-foot">{footer}</div> : null}
    </section>
  );
}

/**
 * A refusal, in the server's own words.
 *
 * ONE SENTENCE, and never a breakdown of which half of a credential was wrong.
 * The status check answers identically for an unknown ticket and a wrong
 * verifier so that it cannot be used to discover who applied; a screen that
 * split that answer back into "ticket not found" and "verifier wrong" would
 * hand back exactly the oracle the server refuses to be.
 */
export function GagalPublik({ pesan }: { pesan: string }) {
  return (
    <p className="publik-gagal" role="alert">
      <Icon name="alert" size={16} />
      <span>{pesan}</span>
    </p>
  );
}

/** A short lived confirmation, e.g. that the ticket number was copied. */
export function useSalin(): [boolean, (teks: string) => void] {
  const [tersalin, setTersalin] = useState(false);
  useEffect(() => {
    if (!tersalin) return;
    const timer = setTimeout(() => setTersalin(false), 2500);
    return () => clearTimeout(timer);
  }, [tersalin]);
  return [
    tersalin,
    (teks: string) => {
      // Optional chaining, not a try/catch: clipboard access is absent in a
      // test document and refused in an insecure context, and neither is an
      // error worth showing over a convenience button.
      void navigator.clipboard?.writeText?.(teks).then(
        () => setTersalin(true),
        () => setTersalin(false),
      );
    },
  ];
}

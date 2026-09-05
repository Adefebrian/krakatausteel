// THE MITRA BINAAN AREA (spec 4.9). The second principal's whole world.
//
// IT REUSES NOTHING FROM THE STAFF SHELL, ON PURPOSE. Not `AppShell`, not
// `SideNav`, not `useSession`, not `nav.ts`, not `permissions.ts`. ADR 0019
// records why the server keeps the two principals apart at every level it has,
// and the argument does not stop at the network boundary: a shell that read a
// staff session would be one bug away from rendering a staff menu to a
// borrower, and a nav table that held both would be one entry away from
// offering one. There is no code path from here into the staff application at
// all, and there is deliberately no link to it either.
//
// WHAT A MITRA SEES, AND NOTHING ELSE: their own profile, their own akad, the
// schedule of each one, and the receipts recorded against it. Three
// destinations, so three tabs on a phone and three in the header on a desk.
//
// THE PASSWORD SCREEN IS A GATE, NOT A PAGE. While the account still holds the
// password an officer handed over, it is the only thing rendered: no tabs, no
// akad, no profile. The server holds the same line (`wajibSandiSendiri`), so
// this is the shell agreeing with it rather than deciding anything, and the
// only two things reachable in that state are the password form and signing
// out.
import { useEffect, type ReactNode } from "react";
import { Icon, type IconName } from "@krakatausteel/ui";
import { useRouter } from "../router";
import { AkadDetailMitra } from "./AkadDetail";
import { AkadMitraList } from "./AkadList";
import { AkunMitra } from "./Akun";
import { BerandaMitra } from "./Beranda";
import { GantiSandiMitra } from "./GantiSandi";
import { MasukMitra } from "./Masuk";
import { PenyediaSesiMitra, useSesiMitra } from "./sesi";

/** True for a path the mitra area owns. Read by ../App.tsx before the staff
 *  session provider is mounted, which is what keeps the two apart. */
export function adalahJalurMitra(path: string): boolean {
  return path === "/mitra" || path.startsWith("/mitra/");
}

interface TujuanMitra {
  path: string;
  label: string;
  judul: string;
  icon: IconName;
}

const TUJUAN: readonly TujuanMitra[] = [
  { path: "/mitra", label: "Beranda", judul: "Beranda", icon: "dashboard" },
  { path: "/mitra/akad", label: "Akad", judul: "Akad Saya", icon: "handshake" },
  { path: "/mitra/akun", label: "Akun", judul: "Akun Saya", icon: "user" },
];

export function MitraApp() {
  return (
    <PenyediaSesiMitra>
      <AkarMitra />
    </PenyediaSesiMitra>
  );
}

function AkarMitra() {
  const { status, error, ulangi } = useSesiMitra();

  if (status === "memuat") {
    return (
      <PesanMitra judul="Memuat" pesan="Sedang membuka sesi Anda." />
    );
  }
  if (status === "gagal") {
    return (
      <PesanMitra
        judul="Server tidak dapat dihubungi"
        pesan={error ?? "Coba lagi beberapa saat lagi."}
        aksi={
          <button type="button" className="mitra-btn is-utama" onClick={ulangi}>
            Coba lagi
          </button>
        }
      />
    );
  }
  if (status === "keluar") return <MasukMitra />;
  // The gate. See the file header: nothing else is reachable from here.
  if (status === "ganti") return <GantiSandiMitra />;

  return <CangkangMitra />;
}

function CangkangMitra() {
  const { path, navigate } = useRouter();
  const { profil } = useSesiMitra();
  const aktif =
    TUJUAN.filter((t) => path === t.path || path.startsWith(`${t.path}/`)).sort(
      (a, b) => b.path.length - a.path.length,
    )[0] ?? TUJUAN[0]!;

  useEffect(() => {
    document.title = `${aktif.judul} - Portal Mitra Binaan`;
  }, [aktif.judul]);

  const akadId = path.startsWith("/mitra/akad/") ? path.slice("/mitra/akad/".length) : null;

  return (
    <div className="mitra-shell">
      <header className="mitra-topbar">
        <div className="mitra-topbar-row">
          <span className="mitra-brand">
            <span className="mitra-mark" aria-hidden="true">
              <Icon name="handshake" size={18} />
            </span>
            <span className="mitra-brand-name">Portal Mitra Binaan</span>
          </span>
          <span className="mitra-identitas">
            <span className="mitra-identitas-nama">{profil?.namaLengkap ?? ""}</span>
            <span className="mitra-identitas-kode">{profil?.kodeMitra ?? ""}</span>
          </span>
        </div>
        <nav className="mitra-nav" aria-label="Halaman portal mitra">
          {TUJUAN.map((tujuan) => (
            <button
              key={tujuan.path}
              type="button"
              className={tujuan.path === aktif.path ? "mitra-nav-btn is-active" : "mitra-nav-btn"}
              aria-current={tujuan.path === aktif.path ? "page" : undefined}
              onClick={() => navigate(tujuan.path)}
            >
              {tujuan.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mitra-main">
        <div className="mitra-lebar">
          {akadId !== null && akadId !== "" ? (
            <AkadDetailMitra akadId={akadId} />
          ) : aktif.path === "/mitra/akad" ? (
            <AkadMitraList />
          ) : aktif.path === "/mitra/akun" ? (
            <AkunMitra />
          ) : (
            <BerandaMitra />
          )}
        </div>
      </main>

      <nav className="mitra-tabbar" aria-label="Navigasi portal mitra">
        {TUJUAN.map((tujuan) => (
          <button
            key={tujuan.path}
            type="button"
            className={tujuan.path === aktif.path ? "mitra-tab is-active" : "mitra-tab"}
            aria-current={tujuan.path === aktif.path ? "page" : undefined}
            onClick={() => navigate(tujuan.path)}
          >
            <Icon name={tujuan.icon} size={20} />
            <span className="mitra-tab-label">{tujuan.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

/** The full page states: loading, and an unreachable server. */
export function PesanMitra({
  judul,
  pesan,
  aksi,
}: {
  judul: string;
  pesan: string;
  aksi?: ReactNode;
}) {
  return (
    <div className="mitra-pesan">
      <div className="mitra-pesan-kotak">
        <h1 className="mitra-pesan-judul">{judul}</h1>
        <p className="mitra-pesan-teks" role="status">
          {pesan}
        </p>
        {aksi}
      </div>
    </div>
  );
}

/** The page frame every mitra screen sits in, so four screens cannot grow four
 *  headings, four paddings and four rhythms. */
export function HalamanMitra({
  judul,
  ringkas,
  children,
}: {
  judul: string;
  ringkas: string;
  children: ReactNode;
}) {
  return (
    <div className="mitra-page">
      <header className="mitra-page-head">
        <h1 className="mitra-page-title">{judul}</h1>
        <p className="mitra-page-sub">{ringkas}</p>
      </header>
      {children}
    </div>
  );
}

/** A card on a mitra page. Same chrome for every one of them. */
export function KartuMitra({
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
    <section className="mitra-kartu">
      <div className="mitra-kartu-head">
        <h2 className="mitra-kartu-judul">{judul}</h2>
        {ringkas ? <p className="mitra-kartu-sub">{ringkas}</p> : null}
      </div>
      <div className="mitra-kartu-body">{children}</div>
      {footer ? <div className="mitra-kartu-foot">{footer}</div> : null}
    </section>
  );
}

export function GagalMitra({ pesan }: { pesan: string }) {
  return (
    <p className="mitra-gagal" role="alert">
      <Icon name="alert" size={16} />
      <span>{pesan}</span>
    </p>
  );
}

// The three states a router must have an answer for: an unknown path, a path
// the permission set does not allow, and an API that cannot be reached.
import { Button, EmptyState } from "@krakatausteel/ui";
import { useRouter } from "../router";
import { useSession } from "../session";

export function NotFound({ path }: { path: string }) {
  const { navigate } = useRouter();
  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">Halaman tidak ditemukan</h1>
        <p className="page-sub">Alamat {path} tidak terdaftar pada aplikasi ini.</p>
      </header>
      <EmptyState
        icon="alert"
        title="Alamat tidak dikenal"
        description="Periksa kembali tautannya, atau kembali ke dashboard lalu pilih menu dari navigasi."
        action={
          <Button variant="primary" onClick={() => navigate("/")}>
            Kembali ke Dashboard
          </Button>
        }
      />
    </div>
  );
}

export function Forbidden({ title }: { title: string }) {
  const { navigate } = useRouter();
  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">Akses ditolak</h1>
        <p className="page-sub">Role Anda tidak memiliki hak akses ke halaman {title}.</p>
      </header>
      <EmptyState
        icon="lock"
        title="Tidak ada hak akses"
        description="Hubungi Admin Cabang atau Admin Pusat bila Anda memang seharusnya bisa membuka halaman ini. Setiap penolakan akses tercatat pada audit log."
        action={
          <Button variant="primary" onClick={() => navigate("/")}>
            Kembali ke Dashboard
          </Button>
        }
      />
    </div>
  );
}

/**
 * Shown only when the API could not answer at all. Deliberately worded so it
 * cannot be mistaken for a rejected login: there is no form here and no
 * mention of a password, because nothing the user types would help.
 */
export function SessionUnreachable() {
  const { error, retry } = useSession();
  const heading = "Server tidak dapat dihubungi";
  // Only shown when the server said something more specific than the heading,
  // so the panel never repeats the same sentence twice.
  const detail = error && error !== heading ? error : null;
  return (
    <main className="boot">
      <div className="boot-panel">
        <h1 className="boot-title">{heading}</h1>
        <p className="boot-body">
          Ini bukan masalah nama pengguna atau kata sandi, jadi masuk ulang tidak akan menolong.
          Data Anda tidak terpengaruh. Coba hubungkan ulang, atau hubungi administrator bila
          kondisi ini berlanjut.
        </p>
        {detail ? <p className="boot-detail">{detail}</p> : null}
        <Button variant="primary" onClick={retry}>
          Coba hubungkan ulang
        </Button>
      </div>
    </main>
  );
}

export function SessionLoading() {
  return (
    <main className="boot">
      <div className="boot-panel">
        <h1 className="boot-title">TJSL Online</h1>
        <p className="boot-body">Memuat sesi dan hak akses.</p>
      </div>
    </main>
  );
}

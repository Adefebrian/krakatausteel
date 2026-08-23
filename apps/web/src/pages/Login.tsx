// Login screen. Two inputs, one primary action, and an honest error line.
//
// The demo hint only renders when the demo stub is reachable (localhost with
// no API), so a deployed build shows a plain login form with no credentials
// printed on it.
import { useState } from "react";
import { Button, Field, Icon, PasswordInput, TextInput } from "@krakatausteel/ui";
import { ApiUnreachableError, DEMO_USERNAMES, UnauthorizedError } from "../api/auth";
import { DASAR_HUKUM } from "../regulasi";
import { useSession } from "../session";

interface FieldErrors {
  username?: string;
  password?: string;
}

const DEMO_VISIBLE = (() => {
  const host = globalThis.location?.hostname ?? "";
  return host === "localhost" || host === "127.0.0.1" || host === "";
})();

export function Login() {
  const { login } = useSession();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors: FieldErrors = {};
    if (username.trim() === "") errors.username = "Nama pengguna wajib diisi";
    if (password === "") errors.password = "Kata sandi wajib diisi";
    setFieldErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    try {
      await login(username, password);
    } catch (cause) {
      if (cause instanceof UnauthorizedError) {
        setFormError("Nama pengguna atau kata sandi salah. Periksa kembali lalu coba lagi.");
      } else if (cause instanceof ApiUnreachableError) {
        setFormError(
          "Server tidak dapat dihubungi. Coba lagi beberapa saat, atau hubungi administrator.",
        );
      } else {
        setFormError("Terjadi kesalahan tak terduga saat masuk.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login">
      <div className="login-panel">
        <div className="login-brand">
          <span className="login-mark" aria-hidden="true">
            <Icon name="pumk" size={22} />
          </span>
          <div>
            <h1 className="login-title">TJSL Online</h1>
            <p className="login-sub">
              Administrasi dan pelaporan program Tanggung Jawab Sosial dan Lingkungan.
            </p>
          </div>
        </div>

        <form className="login-form" onSubmit={onSubmit} noValidate>
          <Field label="Nama pengguna" htmlFor="login-username" error={fieldErrors.username}>
            <TextInput
              id="login-username"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              invalid={Boolean(fieldErrors.username)}
              onChange={(event) => setUsername(event.currentTarget.value)}
            />
          </Field>

          <Field label="Kata sandi" htmlFor="login-password" error={fieldErrors.password}>
            <PasswordInput
              id="login-password"
              name="password"
              autoComplete="current-password"
              value={password}
              invalid={Boolean(fieldErrors.password)}
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
          </Field>

          {formError ? (
            <p className="login-error" role="alert">
              <Icon name="alert" size={18} />
              <span>{formError}</span>
            </p>
          ) : null}

          <Button type="submit" variant="primary" block loading={submitting} loadingLabel="Masuk">
            Masuk
          </Button>
        </form>

        {DEMO_VISIBLE ? (
          <div className="login-demo">
            <p className="login-demo-title">Mode demo lokal</p>
            <p className="login-demo-body">
              API belum tersedia, jadi sesi dilayani stub lokal untuk meninjau tampilan. Masuk
              dengan salah satu nama pengguna berikut dan kata sandi apa pun yang tidak kosong:{" "}
              {DEMO_USERNAMES.join(", ")}.
            </p>
          </div>
        ) : null}

        <p className="login-foot">
          Mengacu pada Peraturan Menteri BUMN Nomor {DASAR_HUKUM.nomor}. Aplikasi ini mencatat
          jurnal atas peristiwa yang sudah terjadi, tidak memindahkan dana.
        </p>
      </div>
    </main>
  );
}

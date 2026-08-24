// Login screen. Two inputs, one primary action, and an honest error line.
//
// Every answer here comes from POST /auth/login. There is no local fallback
// and no credential printed on the screen: a rejected password says so, and a
// server that cannot be reached says that instead, because the two send the
// user to two different people.
import { useState } from "react";
import { Button, Field, Icon, PasswordInput, TextInput } from "@krakatausteel/ui";
import { ApiRequestError, ApiUnreachableError, UnauthorizedError } from "../api/auth";
import { DASAR_HUKUM } from "../regulasi";
import { useSession } from "../session";

interface FieldErrors {
  username?: string;
  password?: string;
}

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
      } else if (cause instanceof ApiRequestError) {
        // 400, 403, and 429 carry a sentence from the server that names the
        // real reason (rate limit, origin), which is more useful than ours.
        setFormError(cause.message);
      } else if (cause instanceof ApiUnreachableError) {
        setFormError(
          "Server tidak dapat dihubungi. Ini bukan masalah kata sandi. Coba lagi beberapa saat, atau hubungi administrator.",
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

        <p className="login-foot">
          Mengacu pada Peraturan Menteri BUMN Nomor {DASAR_HUKUM.nomor}. Aplikasi ini mencatat
          jurnal atas peristiwa yang sudah terjadi, tidak memindahkan dana.
        </p>
      </div>
    </main>
  );
}

-- 0035_administrasi_pengguna.sql  (spec 4.1, spec 9.4 "Manajemen User")
--
-- THE ONE COLUMN THE ADMINISTRATION API CANNOT SHIP WITHOUT.
--
-- Issuing a staff account follows the scheme `modules/mitra` already uses for a
-- borrower's portal account (0006 `portal_akun_mitra.harus_ganti_sandi`): the
-- officer sees a generated one-time password ONCE, it is stored only as an
-- argon2id hash, it is never written to `audit_log`, and the account it opens
-- can do exactly one thing until it replaces that password with one only its
-- owner knows.
--
-- `app_user` had no way to say that. Without this flag the first password an
-- administrator types (or generates) stays valid forever, known to two people,
-- and every act of the account is deniable: "the admin who created me could
-- have done that". The flag is what makes a staff credential attributable.
--
-- WHY A SECOND SCHEME WAS NOT INVENTED. The mitra side proved the shape works
-- and `docs/RESUME.md` and ADR 0019 both treat that flow as the reference. One
-- boolean plus one timestamp is the whole of the mechanism; the enforcement is
-- in `core/app.ts` (a global guard, so a route written later inherits it) and
-- the change of password is `POST /auth/ganti-sandi`.
--
-- `sandi_diubah_at` is evidence, not control: it answers "when did this account
-- last hold a secret only its owner knew", which is the question an auditor
-- asks about a credential an administrator once handed over. NULL means the
-- password has never been replaced since the row was created.
--
-- EXISTING ROWS DEFAULT TO false. A seeded or already-live account is not
-- retroactively locked out of the application by a migration; only accounts
-- created or reset THROUGH the administration API carry the flag. Forcing it
-- true here would lock every existing operator out of a running system on
-- deploy, which is a decision for an operator, not for a migration.

-- up

ALTER TABLE app_user
  ADD COLUMN harus_ganti_sandi BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN sandi_diubah_at TIMESTAMPTZ;

COMMENT ON COLUMN app_user.harus_ganti_sandi IS
  'true while the account still holds a password an administrator knows; the session may then only change it or log out';
COMMENT ON COLUMN app_user.sandi_diubah_at IS
  'when the owner last replaced their own password; NULL = never since the row was created';

-- down
ALTER TABLE app_user
  DROP COLUMN IF EXISTS sandi_diubah_at,
  DROP COLUMN IF EXISTS harus_ganti_sandi;

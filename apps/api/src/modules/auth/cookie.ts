// Session cookie serialisation.
//
// WHY NOT `setCookie` FROM hono/cookie
// Two reasons, in order of importance:
//
//   1. IT IS NOT OBSERVABLE IN THIS TEST SUITE. hono/cookie stashes the header
//      in Hono's prepared-headers map, and Hono rebuilds the Response whenever
//      a later middleware sets a header, so whether `Set-Cookie` survives
//      depends on the runtime's Response implementation. It does under Bun and
//      it does not under the happy-dom globals the suite registers. An
//      authentication cookie whose attributes cannot be asserted in a test is
//      not an acceptable trade for one import. The queue in
//      core/cookies.ts is what writes the header, and its file header has the
//      full argument.
//   2. The attribute set is a security decision worth having written out in
//      one readable place rather than spread across call sites.
//
// The serialisation below follows RFC 6265: attributes in a fixed order,
// `Max-Age` in seconds, and a value that is rejected rather than escaped if it
// contains anything a cookie value may not hold (session ids are base64url, so
// this can only fire on a bug).

export interface SessionCookieOptions {
  name: string;
  value: string;
  /** Seconds. 0 expires the cookie immediately (logout). */
  maxAge: number;
  secure: boolean;
  path?: string;
}

const COOKIE_VALUE_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~/=:]*$/;

export function serializeSessionCookie(options: SessionCookieOptions): string {
  if (!COOKIE_VALUE_RE.test(options.value)) {
    throw new Error("Nilai cookie sesi memuat karakter yang tidak diizinkan");
  }
  const parts = [
    `${options.name}=${options.value}`,
    `Path=${options.path ?? "/"}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`,
    // HttpOnly: script cannot read the session id, so an XSS cannot steal it.
    "HttpOnly",
    // Lax: no cookie on a cross-site POST, which is the CSRF defence
    // (core/hardening.ts adds an Origin check as the second lock). Strict
    // would also drop the cookie on a normal inbound link, logging the user
    // out every time they arrive from an email.
    "SameSite=Lax",
  ];
  // Secure only in production: a Secure cookie is never stored over plain
  // http, so setting it unconditionally would break http://localhost dev.
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

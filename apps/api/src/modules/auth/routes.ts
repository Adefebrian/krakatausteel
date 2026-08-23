// Hono router for /auth. Parses and validates the request, calls the service,
// shapes the response. No authorisation or business logic lives here.
//
// COOKIE POLICY
//   HttpOnly            script cannot read the session id, so an XSS cannot
//                       exfiltrate it
//   SameSite=Lax        no cookie on a cross-site POST, which is the CSRF
//                       defence (core/hardening.ts adds an Origin check as
//                       the second lock)
//   Secure              in production only, because local dev is plain http
//                       and a Secure cookie would simply never be stored
//   Path=/              the SPA and the API share one origin behind Caddy
//   Max-Age             the idle TTL, so the browser drops it on the same
//                       schedule Redis does
// Deliberately NOT `__Host-` prefixed: that forbids Domain and requires
// Secure, which breaks http://localhost development for no gain here.
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { queueSetCookie } from "../../core/cookies";
import { badRequest } from "../../core/http";
import { clientIp } from "../../core/hardening";
import { requirePrincipal, type Guards } from "../../core/principal";
import { serializeSessionCookie } from "./cookie";
import { auditActor, SESSION_COOKIE } from "./guards";
import type { AuthService } from "./service";

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function createAuthRoutes(service: AuthService, guards: Guards) {
  return new Hono()
    .post("/login", async (c) => {
      const body = await c.req
        .json<{ username?: unknown; password?: unknown }>()
        .catch((): { username?: unknown; password?: unknown } => ({}));
      if (body === null || typeof body !== "object") {
        throw badRequest("Body harus berupa objek JSON");
      }

      const { session, payload } = await service.login({
        username: typeof body.username === "string" ? body.username : "",
        password: typeof body.password === "string" ? body.password : "",
        ip: clientIp(c),
        userAgent: (c.req.header("user-agent") ?? null)?.slice(0, 512) ?? null,
      });

      // Queued, not set directly: core/cookies.ts explains why the outermost
      // middleware is what writes it onto the response.
      queueSetCookie(
        c,
        serializeSessionCookie({
          name: SESSION_COOKIE,
          value: session.id,
          maxAge: service.sessions.idleTtlSeconds,
          secure: isProduction(),
        }),
      );
      return c.json(payload, 200);
    })

    // Logout is deliberately NOT behind requireSession: an expired or already
    // invalid cookie must still clear itself and answer 204, otherwise the SPA
    // has no way to get out of a broken session. It is also exempt from the
    // read-only mutation guard, since ending your own session is not a data
    // change (an Auditor has to be able to log out).
    .post("/logout", async (c) => {
      const cookie = getCookie(c, SESSION_COOKIE);
      if (cookie) {
        const resolved = await service.resolveSession(cookie);
        await service.logout(cookie, {
          userId: resolved?.principal.userId ?? null,
          ip: clientIp(c),
          userAgent: (c.req.header("user-agent") ?? null)?.slice(0, 512) ?? null,
        });
      }
      // Max-Age=0 with an empty value: the browser drops the cookie whether
      // or not the session id it held was still valid.
      queueSetCookie(
        c,
        serializeSessionCookie({ name: SESSION_COOKIE, value: "", maxAge: 0, secure: isProduction() }),
      );
      return c.body(null, 204);
    })

    .get("/session", guards.requireSession, async (c) => {
      const principal = requirePrincipal(c);
      return c.json(await service.payloadFor(principal), 200);
    })

    // Cheap "who am I, in audit terms" endpoint. Same guard as /session, no
    // extra permission: a signed-in user may always see their own identity.
    .get("/me", guards.requireSession, (c) => {
      const principal = requirePrincipal(c);
      const actor = auditActor(c);
      return c.json({
        userId: principal.userId,
        username: principal.username,
        roles: principal.roles,
        cabang: principal.cabang,
        lintasCabang: principal.lintasCabang,
        readOnly: principal.readOnly,
        ip: actor.ip,
      });
    });
}

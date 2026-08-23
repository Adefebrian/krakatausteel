// Outbound cookie queue.
//
// WHY A QUEUE INSTEAD OF SETTING THE HEADER IN THE HANDLER
// Hono rebuilds the `Response` object whenever a middleware sets a header
// AFTER the handler returned (see `header()` in hono/dist/context.js: if
// `finalized`, it does `new Response(this.#res.body, this.#res)`). The CORS
// middleware does exactly that on every request. Whether `Set-Cookie`
// survives that rebuild then depends on the runtime's `Response`
// implementation, because the header is special-cased everywhere: under Bun it
// survives, and under the happy-dom globals this repo's test suite registers
// (root bunfig.toml preloads apps/web/src/happydom.ts so React can render) it
// is silently dropped. A session cookie that exists in production but cannot
// be asserted in a test is not something to accept.
//
// So the handler QUEUES the cookie and the OUTERMOST middleware writes it onto
// whatever response actually leaves the app, appending directly to
// `c.res.headers` rather than going through `c.header()` (which would trigger
// another rebuild). Being outermost means no other middleware runs after it,
// so nothing downstream can drop the header, in any runtime. That is a
// robustness property worth having regardless of the test environment.
import type { Context, MiddlewareHandler, Next } from "hono";

const COOKIE_QUEUE_VAR = "outboundCookies";

/** Queues one fully serialised Set-Cookie value for this response. */
export function queueSetCookie(c: Context, serialized: string): void {
  const existing = (c.get(COOKIE_QUEUE_VAR as never) as string[] | undefined) ?? [];
  existing.push(serialized);
  c.set(COOKIE_QUEUE_VAR as never, existing as never);
}

/** Test/inspection helper: what has been queued so far. */
export function queuedCookies(c: Context): readonly string[] {
  return (c.get(COOKIE_QUEUE_VAR as never) as string[] | undefined) ?? [];
}

/**
 * Writes every queued cookie onto the outgoing response. MUST be registered
 * first, so that it is the outermost middleware and therefore the last thing
 * to touch the response.
 */
export const setCookieFlush: MiddlewareHandler = async (c: Context, next: Next) => {
  await next();
  const queue = queuedCookies(c);
  if (queue.length === 0) return;
  for (const cookie of queue) {
    c.res.headers.append("set-cookie", cookie);
  }
};

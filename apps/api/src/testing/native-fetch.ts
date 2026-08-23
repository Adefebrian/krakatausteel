// Access to the runtime's own fetch-API constructors during tests.
//
// See the block at the bottom of tools/test-env.ts for why this exists: under
// the happy-dom globals the suite registers, `new Request(url, { headers: {
// cookie } })` silently drops the cookie, so a test could not send a session
// at all. test-env.ts captures the native constructors before happy-dom loads
// and this module hands them out.
//
// Falls back to the current globals when the property is absent (someone ran a
// file without the preload), so the failure is "cookies do not arrive" rather
// than "cannot read property of undefined".
interface NativeFetchApi {
  Request: typeof Request;
  Response: typeof Response;
  Headers: typeof Headers;
  fetch: typeof fetch;
}

export function nativeFetchApi(): NativeFetchApi {
  const captured = (globalThis as { __BUN_NATIVE_FETCH__?: NativeFetchApi }).__BUN_NATIVE_FETCH__;
  return captured ?? { Request, Response, Headers, fetch };
}

/** True when the current global Request drops the Cookie header. */
export function globalRequestDropsCookies(): boolean {
  const probe = new Request("http://localhost/probe", { headers: { cookie: "probe=1" } });
  return probe.headers.get("cookie") === null;
}

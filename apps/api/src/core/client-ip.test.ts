// Tests for trusted-proxy client IP resolution.
//
// This is a security unit test, not a formatting one. The rule being pinned:
// a client can put ANYTHING in X-Forwarded-For, so only hops appended by our
// own proxies may be believed. Getting this wrong poisons both the rate
// limiter (bypass or denial of service against a third party) and
// audit_log.ip, which spec 2 rule 5 exists to make abuse attributable.
import { describe, expect, test } from "bun:test";
import {
  ipInCidr,
  isIpAddress,
  loadTrustedProxyConfig,
  normaliseIp,
  parseCidr,
  resolveClientIp,
} from "./client-ip";

const SOCKET = "10.0.0.9"; // the Caddy container, as the api sees it
const REAL = "203.0.113.7"; // the actual client
const FORGED = "1.2.3.4"; // whatever the client typed

describe("normaliseIp", () => {
  test("strips ports and brackets and unwraps IPv4-mapped IPv6", () => {
    expect(normaliseIp(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(normaliseIp("203.0.113.7:54321")).toBe("203.0.113.7");
    expect(normaliseIp("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(normaliseIp("[2001:db8::1]")).toBe("2001:db8::1");
    // A dual-stack socket reports a v4 peer like this; audit_log.ip is INET
    // and reading 100 rows of ::ffff: prefixes is nobody's idea of evidence.
    expect(normaliseIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  test("rejects anything that is not an address", () => {
    expect(normaliseIp("")).toBeNull();
    expect(normaliseIp("unknown")).toBeNull();
    expect(normaliseIp("999.1.1.1")).toBeNull();
    expect(normaliseIp("203.0.113.7.8")).toBeNull();
    // Leading zeros are how an octal-parsing bypass is written.
    expect(normaliseIp("010.0.0.1")).toBeNull();
    expect(normaliseIp("<script>")).toBeNull();
  });

  test("isIpAddress agrees, because audit_log.ip is an INET column", () => {
    expect(isIpAddress("203.0.113.7")).toBe(true);
    expect(isIpAddress("2001:db8::1")).toBe(true);
    expect(isIpAddress("not-an-ip")).toBe(false);
  });
});

describe("resolveClientIp with no trusted proxy (the default)", () => {
  const config = { count: 0, cidrs: [] };

  test("ignores X-Forwarded-For entirely and uses the socket", () => {
    expect(resolveClientIp({ forwardedFor: `${FORGED}, ${REAL}`, socketAddress: SOCKET }, config)).toBe(SOCKET);
  });

  test("returns null rather than a fake string when there is no socket either", () => {
    // null is a real answer callers must handle: the rate limiter falls back
    // to a per-route bucket and audit_log stores NULL. The old code invented
    // "unknown", which put every unidentifiable request in one shared bucket.
    expect(resolveClientIp({ forwardedFor: FORGED, socketAddress: null }, config)).toBeNull();
  });
});

describe("resolveClientIp with one trusted proxy (the production topology)", () => {
  const config = { count: 1, cidrs: [] };

  test("takes the hop the proxy appended, not the leftmost one", () => {
    // Caddy forwards "<whatever the client sent>, <the client's real IP>".
    expect(resolveClientIp({ forwardedFor: `${FORGED}, ${REAL}`, socketAddress: SOCKET }, config)).toBe(REAL);
  });

  test("a long forged chain cannot move the answer", () => {
    const forged = ["9.9.9.9", "8.8.8.8", "7.7.7.7", "192.168.1.1"].join(", ");
    expect(
      resolveClientIp({ forwardedFor: `${forged}, ${REAL}`, socketAddress: SOCKET }, config),
    ).toBe(REAL);
  });

  test("a single-entry chain is the client, which is the normal case", () => {
    expect(resolveClientIp({ forwardedFor: REAL, socketAddress: SOCKET }, config)).toBe(REAL);
  });

  test("no XFF at all falls back to the socket", () => {
    expect(resolveClientIp({ forwardedFor: null, socketAddress: SOCKET }, config)).toBe(SOCKET);
  });

  test("garbage entries are dropped, not trusted", () => {
    expect(
      resolveClientIp({ forwardedFor: `unknown, , ${REAL}`, socketAddress: SOCKET }, config),
    ).toBe(REAL);
    // Every entry unusable: fall back to the socket rather than to "".
    expect(resolveClientIp({ forwardedFor: "unknown, nonsense", socketAddress: SOCKET }, config)).toBe(SOCKET);
  });

  test("ports in the chain are stripped (some proxies append host:port)", () => {
    expect(resolveClientIp({ forwardedFor: `${FORGED}, ${REAL}:41234`, socketAddress: SOCKET }, config)).toBe(REAL);
  });
});

describe("resolveClientIp with two trusted proxies", () => {
  const config = { count: 2, cidrs: [] };

  test("skips both of our hops and takes the client", () => {
    // client -> CDN -> Caddy -> api: XFF is "<forged>, <client>, <cdn edge>"
    expect(
      resolveClientIp({ forwardedFor: `${FORGED}, ${REAL}, 198.51.100.5`, socketAddress: SOCKET }, config),
    ).toBe(REAL);
  });

  test("a chain shorter than the configured depth falls back to the socket", () => {
    // The request did not arrive through the expected path (direct hit on the
    // container). Believing the only entry present would mean believing the
    // client, so the socket address is the only fact left.
    expect(resolveClientIp({ forwardedFor: FORGED, socketAddress: SOCKET }, config)).toBe(SOCKET);
  });
});

describe("resolveClientIp with a trusted CIDR list", () => {
  const config = { count: 0, cidrs: [parseCidr("10.0.0.0/8")!, parseCidr("172.16.0.0/12")!] };

  test("walks past our own infrastructure hops from the right", () => {
    expect(
      resolveClientIp(
        { forwardedFor: `${FORGED}, ${REAL}, 10.4.4.4, 172.16.9.9`, socketAddress: SOCKET },
        config,
      ),
    ).toBe(REAL);
  });

  test("stops at the first hop outside the trusted networks", () => {
    expect(
      resolveClientIp({ forwardedFor: `${FORGED}, ${REAL}, 10.1.1.1`, socketAddress: SOCKET }, config),
    ).toBe(REAL);
  });

  test("a client claiming a private address cannot walk the list further", () => {
    // Forging "10.0.0.1" as the LAST entry is the interesting attack: it makes
    // the walker skip one more hop. It still cannot reach past the entry our
    // own proxy appended, because that entry is what the walk lands on.
    const chain = `${FORGED}, 10.9.9.9, ${REAL}`;
    expect(resolveClientIp({ forwardedFor: chain, socketAddress: SOCKET }, config)).toBe(REAL);
  });
});

describe("parseCidr and ipInCidr", () => {
  test("matches inside and outside the block", () => {
    const cidr = parseCidr("10.0.0.0/8")!;
    expect(ipInCidr("10.255.255.255", cidr)).toBe(true);
    expect(ipInCidr("11.0.0.1", cidr)).toBe(false);
    expect(ipInCidr("2001:db8::1", cidr)).toBe(false);
  });

  test("handles a bare address as a /32 and an IPv6 block", () => {
    expect(ipInCidr("203.0.113.7", parseCidr("203.0.113.7")!)).toBe(true);
    expect(ipInCidr("203.0.113.8", parseCidr("203.0.113.7")!)).toBe(false);
    const v6 = parseCidr("2001:db8::/32")!;
    expect(ipInCidr("2001:db8:1234::1", v6)).toBe(true);
    expect(ipInCidr("2001:db9::1", v6)).toBe(false);
  });

  test("rejects malformed input instead of matching everything", () => {
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("not-a-cidr")).toBeNull();
    expect(parseCidr("")).toBeNull();
  });
});

describe("loadTrustedProxyConfig", () => {
  test("defaults to zero trusted proxies", () => {
    const config = loadTrustedProxyConfig({});
    expect(config.count).toBe(0);
    expect(config.cidrs).toHaveLength(0);
  });

  test("reads the count and the CIDR list", () => {
    const config = loadTrustedProxyConfig({
      TRUSTED_PROXY_COUNT: "1",
      TRUSTED_PROXY_CIDRS: "10.0.0.0/8, 172.16.0.0/12",
    });
    expect(config.count).toBe(1);
    expect(config.cidrs).toHaveLength(2);
  });

  test("a malformed value is a hard error, never a silent 0", () => {
    // Silently falling back to 0 would make every production audit row record
    // the Caddy container's address, which is unusable as evidence.
    expect(() => loadTrustedProxyConfig({ TRUSTED_PROXY_COUNT: "one" })).toThrow(/TRUSTED_PROXY_COUNT/);
    expect(() => loadTrustedProxyConfig({ TRUSTED_PROXY_COUNT: "-1" })).toThrow(/TRUSTED_PROXY_COUNT/);
    expect(() => loadTrustedProxyConfig({ TRUSTED_PROXY_CIDRS: "10.0.0.0/99" })).toThrow(/TRUSTED_PROXY_CIDRS/);
  });
});

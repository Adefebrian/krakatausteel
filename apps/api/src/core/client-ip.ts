// Trusted-proxy aware client IP resolution.
//
// THE BUG THIS REPLACES
// The previous rate limiter read `x-forwarded-for` and took the LEFTMOST hop.
// XFF is append-only and client-controlled: anyone can send
//   X-Forwarded-For: 1.2.3.4
// and Caddy will forward it as "1.2.3.4, <real client>". Taking the leftmost
// value therefore means:
//   - the rate limiter is keyed on a value the attacker picks, so it can be
//     rotated at will (limit bypassed) or set to a victim's address (limit
//     poisoned against someone else);
//   - audit_log.ip, which spec 2 rule 5 exists to make abuse attributable,
//     records whatever the attacker typed. A forged audit trail is worse than
//     no audit trail.
//
// THE RULE
// Only hops appended by infrastructure we control are trustworthy. Counting
// from the RIGHT of the XFF list, the first N entries were appended by our own
// N proxies; entry N+1 from the right is the address our outermost proxy saw
// as its peer, i.e. the real client. Anything further left is client-supplied
// text and is ignored entirely.
//
//   trustedProxyCount = 0  ->  ignore XFF completely, use the socket address.
//   trustedProxyCount = 1  ->  the production topology in
//                              infra/docker-compose.prod.yml: one Caddy in
//                              front of the api container. Take XFF[last].
//
// Alternatively a CIDR allowlist (TRUSTED_PROXY_CIDRS) walks the list from the
// right and skips hops that are inside a trusted network, which is the correct
// shape when the number of proxies varies (a CDN in front of Caddy). When both
// are configured the CIDR walk runs first and the count is the floor.
//
// AND THE PEER MUST BE ONE OF OURS. Counting hops is only meaningful if the
// request actually arrived through our proxy, so `resolveClientIp` ignores
// X-Forwarded-For entirely when the socket peer is not inside the trusted
// networks. Otherwise "one trusted hop" means "anyone who can reach the port
// may name their own address", which is the same bug in a different place.
//
// Everything in this file is pure: it takes headers plus the socket address
// and returns a string. That is what makes forged-chain tests possible without
// a live server.

/** Parsed, validated trusted-proxy configuration. */
export interface TrustedProxyConfig {
  /** Number of proxies we operate, counted from the socket inwards. */
  count: number;
  /** CIDR blocks whose addresses are our own infrastructure. */
  cidrs: readonly Cidr[];
}

export interface Cidr {
  /** Network address as a big integer. */
  network: bigint;
  /** Mask length in bits. */
  bits: number;
  /** 4 or 6. */
  family: 4 | 6;
  /** Original text, for error messages. */
  text: string;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Strips an optional `:port` and IPv6 brackets, and unwraps ::ffff: mapped v4. */
export function normaliseIp(raw: string): string | null {
  let value = raw.trim();
  if (value.length === 0) return null;
  // "[::1]:1234" or "[::1]"
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0) return null;
    value = value.slice(1, close);
  } else if (value.includes(".") && value.split(":").length === 2) {
    // "1.2.3.4:5678" -> "1.2.3.4". Exactly one colon, because an
    // IPv4-mapped IPv6 ("::ffff:1.2.3.4") also has dots and has more.
    value = value.slice(0, value.indexOf(":"));
  }
  // IPv4-mapped IPv6, which is what a dual-stack socket reports for a v4 peer.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(value);
  if (mapped) value = mapped[1]!;
  return isIpv4(value) || isIpv6(value) ? value.toLowerCase() : null;
}

export function isIpv4(value: string): boolean {
  const m = IPV4_RE.exec(value);
  if (!m) return false;
  return m.slice(1).every((part) => {
    const n = Number(part);
    // `String(n) === part` also rejects a leading zero ("010"), which is how
    // an octal-parsing bypass is written: some parsers read 010 as 8.
    return n <= 255 && String(n) === part;
  });
}

export function isIpv6(value: string): boolean {
  if (!value.includes(":")) return false;
  if (/[^0-9a-fA-F:.]/.test(value)) return false;
  const doubleColons = value.split("::").length - 1;
  if (doubleColons > 1) return false;
  const groups = value.split(":").filter((g) => g.length > 0);
  if (groups.length > 8) return false;
  return groups.every((g) => (g.includes(".") ? isIpv4(g) : /^[0-9a-fA-F]{1,4}$/.test(g)));
}

/** True for any syntactically valid IP address; audit_log.ip is INET typed. */
export function isIpAddress(value: string): boolean {
  return isIpv4(value) || isIpv6(value);
}

function ipToBigInt(value: string): { value: bigint; family: 4 | 6 } | null {
  if (isIpv4(value)) {
    const parts = value.split(".").map(Number);
    let n = 0n;
    for (const part of parts) n = (n << 8n) | BigInt(part);
    return { value: n, family: 4 };
  }
  if (!isIpv6(value)) return null;
  const [head, tail] = value.split("::") as [string, string | undefined];
  const headGroups = head.length > 0 ? head.split(":") : [];
  const tailGroups = tail && tail.length > 0 ? tail.split(":") : [];
  const expand = (groups: string[]): string[] => {
    const out: string[] = [];
    for (const g of groups) {
      if (g.includes(".")) {
        const parts = g.split(".").map(Number);
        out.push(((parts[0]! << 8) | parts[1]!).toString(16));
        out.push(((parts[2]! << 8) | parts[3]!).toString(16));
      } else {
        out.push(g);
      }
    }
    return out;
  };
  const left = expand(headGroups);
  const right = expand(tailGroups);
  const fill = 8 - left.length - right.length;
  if (fill < 0) return null;
  const all = [...left, ...Array<string>(tail === undefined ? 0 : fill).fill("0"), ...right];
  if (all.length !== 8) return null;
  let n = 0n;
  for (const g of all) n = (n << 16n) | BigInt(parseInt(g, 16));
  return { value: n, family: 6 };
}

export function parseCidr(text: string): Cidr | null {
  const [addr, bitsText] = text.trim().split("/");
  if (!addr) return null;
  const parsed = ipToBigInt(addr);
  if (!parsed) return null;
  const width = parsed.family === 4 ? 32 : 128;
  const bits = bitsText === undefined ? width : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return null;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(width - bits);
  return { network: parsed.value & mask, bits, family: parsed.family, text: text.trim() };
}

export function ipInCidr(ip: string, cidr: Cidr): boolean {
  const parsed = ipToBigInt(ip);
  if (!parsed || parsed.family !== cidr.family) return false;
  const width = cidr.family === 4 ? 32 : 128;
  const mask = cidr.bits === 0 ? 0n : ((1n << BigInt(cidr.bits)) - 1n) << BigInt(width - cidr.bits);
  return (parsed.value & mask) === cidr.network;
}

/**
 * Reads the trusted-proxy configuration out of the environment.
 *
 * Defaults to ZERO trusted proxies, i.e. XFF is ignored and the socket
 * address wins. That is the only safe default for an unknown topology: a
 * process reachable directly (local dev, `bun run dev`, a misconfigured
 * deploy) must never believe a header. The production stack sets
 * TRUSTED_PROXY_COUNT=1 explicitly in infra/docker-compose.prod.yml, matching
 * its single Caddy.
 *
 * A malformed value is a hard error, not a silent 0: quietly ignoring
 * "TRUSTED_PROXY_COUNT=one" would leave every production log recording the
 * Caddy container's address, which is unusable for an audit trail.
 *
 * Whatever is configured here, X-Forwarded-For is only read when the request's
 * own peer is one of our proxies: TRUSTED_PROXY_CIDRS when set, otherwise the
 * private/loopback ranges (see `peerTepercaya`).
 */
export function loadTrustedProxyConfig(env: Record<string, string | undefined> = process.env): TrustedProxyConfig {
  const rawCount = env.TRUSTED_PROXY_COUNT?.trim();
  let count = 0;
  if (rawCount !== undefined && rawCount.length > 0) {
    const parsed = Number(rawCount);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 16) {
      throw new Error(
        `TRUSTED_PROXY_COUNT harus bilangan bulat 0..16, bukan "${rawCount}". ` +
          "0 berarti X-Forwarded-For diabaikan sepenuhnya (pakai alamat socket).",
      );
    }
    count = parsed;
  }

  const cidrs: Cidr[] = [];
  const rawCidrs = env.TRUSTED_PROXY_CIDRS?.trim();
  if (rawCidrs) {
    for (const part of rawCidrs.split(",").map((p) => p.trim()).filter((p) => p.length > 0)) {
      const cidr = parseCidr(part);
      if (!cidr) throw new Error(`TRUSTED_PROXY_CIDRS memuat entri tidak valid: "${part}"`);
      cidrs.push(cidr);
    }
  }
  return { count, cidrs };
}

export interface ClientIpInput {
  /** Raw `X-Forwarded-For` header value, if present. */
  forwardedFor?: string | null;
  /** Peer address of the TCP connection, as reported by the server. */
  socketAddress?: string | null;
}

/**
 * Resolves the real client IP, or `null` when it cannot be established.
 *
 * `null` is a legitimate answer and callers must handle it (the rate limiter
 * falls back to a per-route bucket, the audit log stores NULL in an INET
 * column). Inventing "unknown" as a string was the other half of the old bug:
 * every unidentifiable request shared one rate-limit bucket.
 */
/**
 * Private, loopback and link-local ranges: the addresses a reverse proxy we
 * operate can plausibly reach us from. Used as the implicit peer allowlist
 * when only TRUSTED_PROXY_COUNT is configured, because a container behind
 * Caddy gets whatever address the docker bridge hands out and pinning it in
 * env would break on every network recreate.
 */
const JARINGAN_PRIVAT: readonly Cidr[] = [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
]
  .map((text) => parseCidr(text))
  .filter((cidr): cidr is Cidr => cidr !== null);

/**
 * Is the process's own peer one of our proxies?
 *
 * X-Forwarded-For may only be believed when the request actually arrived from
 * a proxy we operate. Without this check, configuring a single trusted hop was
 * enough to let ANY direct caller dictate its own address: with
 * TRUSTED_PROXY_CIDRS=127.0.0.0/8 and a peer of ::1, a plain `XFF: 9.9.9.9`
 * resolved to 9.9.9.9, and so did `9.9.9.9, 127.0.0.1`, where a
 * client-supplied hop was counted as one of ours. The rate limiter and
 * audit_log.ip then run on attacker-chosen values, which is the whole reason
 * the leftmost-hop bug was a finding in the first place.
 *
 * An UNKNOWN peer (null) is treated as trusted, deliberately: that only
 * happens where there is no socket at all, i.e. a synthetic `app.request()` in
 * a test. Under `Bun.serve` the peer is always available, so nothing an
 * attacker can send produces null.
 */
export function peerTepercaya(socket: string | null, config: TrustedProxyConfig): boolean {
  if (socket === null) return true;
  const allowlist = config.cidrs.length > 0 ? config.cidrs : JARINGAN_PRIVAT;
  return allowlist.some((cidr) => ipInCidr(socket, cidr));
}

export function resolveClientIp(input: ClientIpInput, config: TrustedProxyConfig): string | null {
  const socket = input.socketAddress ? normaliseIp(input.socketAddress) : null;

  if (config.count === 0 && config.cidrs.length === 0) {
    return socket;
  }

  // The request did not come from one of our proxies, so its X-Forwarded-For
  // is just text the caller typed. The socket address is the only fact.
  if (!peerTepercaya(socket, config)) {
    return socket;
  }

  const hops = (input.forwardedFor ?? "")
    .split(",")
    .map((hop) => normaliseIp(hop))
    .filter((hop): hop is string => hop !== null);

  if (hops.length === 0) return socket;

  // Walk from the right. The rightmost entry was appended by the proxy
  // closest to us, so it is the address that proxy's own peer had.
  let index = hops.length - 1;
  let trusted = 0;

  // CIDR walk: skip every rightmost hop that is one of our own proxies.
  if (config.cidrs.length > 0) {
    while (index >= 0 && config.cidrs.some((cidr) => ipInCidr(hops[index]!, cidr))) {
      index -= 1;
      trusted += 1;
    }
  }

  // Count-based hops: each configured proxy consumed one entry. The entry the
  // outermost proxy appended IS the client, so only count-1 further entries
  // are skipped beyond the one we are about to return.
  const remaining = Math.max(0, config.count - trusted - 1);
  index -= remaining;

  if (index < 0) {
    // The chain is shorter than the configured proxy depth: the request did
    // not come through the expected path (direct hit on the container, or a
    // proxy that does not append). The socket address is the only fact left.
    return socket;
  }
  return hops[index] ?? socket;
}

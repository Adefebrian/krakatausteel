// Port interface for rate limiting. Modules depend on this shape, never on
// `ioredis` directly. See core/adapters/ratelimit.ts.
//
// Two policies exist, and which one applies is a security decision, not an
// implementation detail, so it is chosen where the limiter is CONSTRUCTED
// (core/app.ts) and visible in the wiring:
//
//   failOpen: true   the global limiter. Redis down must not take the whole
//                    API down; a burst getting through is the lesser evil.
//   failOpen: false  the auth/OTP-style limiter. Redis down means the session
//                    store is down too, so no login could succeed anyway;
//                    refusing is both safe and honest. This is what stops a
//                    password-spray attack from simply DoS-ing Redis first.
export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window; 0 once the limit is reached. */
  remaining: number;
  /** Seconds until the window resets. Sent as `Retry-After` on a 429. */
  retryAfterSeconds: number;
}

export interface RateLimiterPort {
  /** Counts one hit against `key` and reports whether it is allowed. */
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  /** Drops the counter for `key`. Used after a successful login. */
  reset(key: string): Promise<void>;
}

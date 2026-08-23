// The interfaces this module consumes from core. Re-exported, not redefined,
// per the module anatomy in skills/jal-architecture: the concrete adapters
// live in src/core/, this file only names the shapes this module depends on.
export type { DbPort, QueryRunner } from "../../core/ports/db";
export type { KeyValueStorePort } from "../../core/ports/keyvalue";
export type { RateLimiterPort } from "../../core/ports/ratelimit";
export type { Guards, Principal, PrincipalCabang } from "../../core/principal";

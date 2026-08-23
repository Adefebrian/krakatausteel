// The interfaces this module consumes from core. Re-exported, not redefined,
// per the module anatomy in skills/jal-architecture: the concrete adapter
// lives in src/core/, this file only names the shapes this module depends on.
export type { DbPort, QueryRunner } from "../../core/ports/db";
export type { Guards, Principal } from "../../core/principal";

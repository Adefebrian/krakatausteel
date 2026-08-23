// The ONLY file another module or the app entrypoint may import from this
// module.
//
// No HTTP surface on purpose: a document number is allocated as a side effect
// of creating a document (a proposal, an akad, a journal), inside that
// operation's transaction. Exposing "give me a number" as an endpoint would
// let a client burn numbers and leave gaps in an official series with no
// document to account for them. Later phases call the service.
export { createNomorService } from "./service";
export type { GenerateInput, NomorHasil, NomorService, NomorServiceDeps } from "./service";
export { DEFAULT_FORMAT_TEMPLATE, formatNomor, bulanRomawi } from "./format";
export type { FormatKonteks } from "./format";
export type { SeriKey } from "./repo";

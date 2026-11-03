// Public API of the decode module — callers outside it import from here
// only (routes/decode.ts today; the PDA/admin cutover next). Internal pure
// codecs (./codecs.js) are importable by db modules that already use them
// (normalizePartNo etc.), but new decode logic goes through decodeScan.
export { decodeScan } from "./service.js";
export { decodeWithTemplates } from "./template.js";
export type { DecodedScan, ScanDecodeInput } from "./template.js";
export type { DateCodePeriod, ParsedScanFields } from "./codecs.js";

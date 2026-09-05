// Port for turning a self-contained HTML document into a PDF.
//
// A module depends on this shape and never on `puppeteer-core`, for the same
// reason it depends on `DbPort` and not on `pg`: the browser is infrastructure,
// it may be absent on a given host, and the decision about what to do when it
// is absent belongs to the caller rather than to a driver import.
//
// THE PORT IS ALLOWED TO BE UNAVAILABLE, and that is deliberate rather than a
// weakness. `tersedia()` answers without launching anything, so a route can
// give an operator a 503 with a sentence they can act on ("print the HTML
// version from your browser") instead of a stack trace from a missing binary.
export interface OpsiPdf {
  /** A4 landscape suits a wide report table; the caller may say otherwise. */
  lanskap?: boolean;
  /** Hard ceiling on one render, in milliseconds. */
  batasWaktuMs?: number;
}

export interface PdfPort {
  /** False when no browser is configured or reachable on this host. */
  tersedia(): boolean;
  /**
   * Renders one document. The HTML MUST be self-contained: the adapter blocks
   * every network request the page makes, so an external stylesheet or image
   * does not slow the render down, it simply never arrives.
   */
  dariHtml(html: string, opsi?: OpsiPdf): Promise<Uint8Array>;
  /** Releases the browser, if one was started. Called on shutdown. */
  tutup(): Promise<void>;
}

/**
 * NOT named `*Error`: core/http.ts recognises a domain error by an allowlist of
 * class names and a sweep test guards it. This is an infrastructure failure
 * with no HTTP meaning of its own; the one call site translates it into the
 * reporting module's own vocabulary.
 */
export class KesalahanPdf extends Error {
  readonly sebab: "TIDAK_TERSEDIA" | "GAGAL_RENDER" | "TERLALU_LAMA" | "TERLALU_SIBUK";
  constructor(sebab: KesalahanPdf["sebab"], message: string) {
    super(message);
    this.name = "KesalahanPdf";
    this.sebab = sebab;
  }
}

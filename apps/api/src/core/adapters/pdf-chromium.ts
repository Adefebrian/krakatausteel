// The PDF adapter: headless Chromium through `puppeteer-core`, and every
// constraint that makes running a browser inside an API process defensible.
//
// ---------------------------------------------------------------------------
// WHY THIS IS NOT THE ONLY PDF PATH, STATED HERE BECAUSE IT IS A REAL OBJECTION
// ---------------------------------------------------------------------------
// `puppeteer-core` is already in this repository, so the PDF feature adds no
// npm dependency. What it DOES add, and what nobody's dependency count shows,
// is a ~400 MB browser binary in the production image and a process that forks
// a renderer per export. The API container today is a Bun image with no
// Chromium in it, so on the server as it currently ships this adapter reports
// `tersedia() === false` and every PDF request is answered 503 with a sentence
// telling the operator what to do instead.
//
// That is why `format=html` exists and is the DEFAULT printable path: it is
// the same layout, it needs nothing on the server, and it hands the user the
// print dialog of the browser they are already looking at. This adapter is for
// the case where a PDF must be produced by the SERVER -- an attachment, a
// scheduled job, an artefact somebody wants to hash -- and it turns on by
// setting `CHROMIUM_PATH`, deliberately, per host.
//
// ---------------------------------------------------------------------------
// THE FOUR THINGS THAT MAKE IT SAFE
// ---------------------------------------------------------------------------
// 1. NO NETWORK. Every request the page makes is aborted except the initial
//    document. The report HTML is self-contained by construction
//    (core/ekspor/html.ts has no `<script>`, no `<img>`, no `<link>`), so this
//    costs nothing legitimate and closes SSRF: a partner address that somehow
//    became markup still cannot reach the cloud metadata endpoint, and a
//    `file://` reference cannot read the server's disk.
// 2. NO JAVASCRIPT. `setJavaScriptEnabled(false)`. The document does not need
//    it, and a renderer that cannot run script cannot be driven by one.
// 3. ONE RENDER AT A TIME, with a queue depth. A browser is the most expensive
//    thing in this process; without a gate, ten concurrent exports of a
//    20 000-row report is a denial of service any authenticated user can
//    trigger, and the rate limiter alone does not bound MEMORY.
// 4. A HARD DEADLINE. The page is closed and the promise rejects at
//    `batasWaktuMs`, so a pathological layout cannot pin a renderer forever.
import { existsSync } from "node:fs";
import { KesalahanPdf, type OpsiPdf, type PdfPort } from "../ports/pdf";

/**
 * `CHROMIUM_PATH`, AND NOTHING ELSE. There is deliberately no search of
 * `/usr/bin/chromium`, `/Applications/Google Chrome.app` and the rest.
 *
 * Discovery would mean the API behaves differently on a laptop that happens to
 * have Chrome installed than on the server that does not: a developer would
 * never see the 503 the operator gets, and a test suite would render real PDFs
 * on one machine and skip them on another. Worse, it would silently start a
 * browser subprocess inside an accounting API because somebody installed a
 * browser for something else. Turning on a renderer is a DEPLOYMENT decision
 * and it is named in one variable.
 */
export function cariChromium(env: NodeJS.ProcessEnv = process.env): string | null {
  const dari = env.CHROMIUM_PATH?.trim();
  if (!dari) return null;
  return existsSync(dari) ? dari : null;
}

export interface PdfChromiumDeps {
  /**
   * Overrides `CHROMIUM_PATH`. `null` means "there is no browser" and is what a
   * test passes to reach the 503 path deterministically; `undefined` (the
   * default) reads the environment.
   */
  executablePath?: string | null;
  /** Concurrent renders. One, unless a host has been sized for more. */
  maksParalel?: number;
  /** Requests allowed to wait. Beyond this the caller is refused, not queued. */
  maksAntre?: number;
  batasWaktuMsBawaan?: number;
}

/**
 * A tiny semaphore. Deliberately hand-rolled and eight lines long: the only
 * alternative is a dependency, and what it has to get right is one counter.
 */
class Gerbang {
  private aktif = 0;
  private antre: Array<() => void> = [];

  constructor(
    private readonly maks: number,
    private readonly maksAntre: number,
  ) {}

  async masuk(): Promise<void> {
    if (this.aktif < this.maks) {
      this.aktif += 1;
      return;
    }
    if (this.antre.length >= this.maksAntre) {
      throw new KesalahanPdf(
        "TERLALU_SIBUK",
        "Terlalu banyak permintaan PDF sedang diproses. Coba lagi sebentar lagi.",
      );
    }
    await new Promise<void>((resolve) => this.antre.push(resolve));
    this.aktif += 1;
  }

  keluar(): void {
    this.aktif -= 1;
    const berikut = this.antre.shift();
    if (berikut) berikut();
  }
}

export function createPdfChromiumAdapter(deps: PdfChromiumDeps = {}): PdfPort {
  const path = deps.executablePath === undefined ? cariChromium() : deps.executablePath;
  const gerbang = new Gerbang(deps.maksParalel ?? 1, deps.maksAntre ?? 4);
  const batasBawaan = deps.batasWaktuMsBawaan ?? 20_000;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any = null;
  let membuka: Promise<unknown> | null = null;

  async function ambilBrowser(): Promise<unknown> {
    if (browser) return browser;
    if (!membuka) {
      membuka = (async () => {
        const puppeteer = (await import("puppeteer-core")).default;
        browser = await puppeteer.launch({
          executablePath: path!,
          headless: true,
          // `--no-sandbox` is NOT here. It is the flag every tutorial adds to
          // make Chrome start in a container as root, and it removes the
          // renderer sandbox -- the last thing between a renderer bug and the
          // API process. A host that needs it should run the container as a
          // non-root user with the right capabilities instead.
          args: ["--disable-gpu", "--disable-dev-shm-usage", "--no-first-run"],
        });
        return browser;
      })().catch((err) => {
        membuka = null;
        throw new KesalahanPdf(
          "TIDAK_TERSEDIA",
          `Browser untuk mencetak PDF tidak bisa dijalankan: ${(err as Error).message}`,
        );
      });
    }
    return membuka;
  }

  return {
    tersedia(): boolean {
      return typeof path === "string" && path.length > 0;
    },

    async dariHtml(html: string, opsi: OpsiPdf = {}): Promise<Uint8Array> {
      if (!path) {
        throw new KesalahanPdf(
          "TIDAK_TERSEDIA",
          "Server ini tidak punya browser untuk mencetak PDF. Gunakan ekspor HTML lalu cetak dari browser Anda.",
        );
      }
      const batas = opsi.batasWaktuMs ?? batasBawaan;
      await gerbang.masuk();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let page: any = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const b = (await ambilBrowser()) as any;
        page = await b.newPage();
        await page.setJavaScriptEnabled(false);
        await page.setRequestInterception(true);
        page.on("request", (req: { isInterceptResolutionHandled?: () => boolean; resourceType(): string; abort(): Promise<void>; continue(): Promise<void> }) => {
          // Only the document itself. Everything else -- and there is nothing
          // else in a document this codebase produced -- is refused.
          if (req.resourceType() === "document") void req.continue();
          else void req.abort();
        });
        await page.setContent(html, { waitUntil: "load", timeout: batas });
        const buf: Uint8Array = await page.pdf({
          format: "A4",
          landscape: opsi.lanskap !== false,
          printBackground: true,
          preferCSSPageSize: true,
          timeout: batas,
        });
        return new Uint8Array(buf);
      } catch (err) {
        if (err instanceof KesalahanPdf) throw err;
        const pesan = (err as Error).message ?? "";
        throw new KesalahanPdf(
          /timeout|timed out/i.test(pesan) ? "TERLALU_LAMA" : "GAGAL_RENDER",
          `Gagal mencetak PDF: ${pesan}`,
        );
      } finally {
        if (page) await page.close().catch(() => {});
        gerbang.keluar();
      }
    },

    async tutup(): Promise<void> {
      const b = browser;
      browser = null;
      membuka = null;
      if (b) await b.close().catch(() => {});
    },
  };
}

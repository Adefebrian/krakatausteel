// apps/api/src/modules/ai/redaksi.ts
//
// THE PERSONAL-DATA DECISION, IN CODE RATHER THAN IN A COMMENT.
//
// This system holds NIK, addresses, telephone numbers and per-person
// outstanding balances. Calling a third-party API means some of that leaves the
// building, so the question "what is allowed into a prompt" has to be answered
// once, deliberately, and then ENFORCED -- a policy written in a comment is one
// careless prompt string away from not existing.
//
// THE ANSWER
//
//   NEVER SENT. NIK, NPWP, e-mail addresses, telephone numbers, and any run of
//   ten or more digits (bank accounts, KK numbers, NIB, and whatever the next
//   identifier turns out to be). `redaksiDokumen` replaces each with a stable
//   placeholder BEFORE the prompt is built, and `rehidrasi` puts the original
//   back AFTER the answer returns. The model sees `[[NIK_1]]`; the Maker's form
//   is filled with the real NIK. Utility is unchanged and the identifier never
//   crosses the wire.
//
//   SENT. Personal and business names, addresses, free-text descriptions,
//   amounts, dates and short document numbers. These are the payload the
//   assistant exists to read: no pattern can locate a person's name or a street
//   address without a model, so redacting them would leave nothing to extract.
//   This is a deliberate trade and it is stated plainly here so whoever
//   disagrees can find it and argue with it.
//
//   NEVER REACHABLE. Anything from the ledger or the borrower file. The
//   extraction path takes its text from the REQUEST and holds no read of
//   business data at all; the anomaly path, which does read the ledger, calls
//   no provider. There is no code path in this module on which a customer's
//   outstanding balance can reach a prompt.
//
// THE MAP IS PER REQUEST AND LIVES IN MEMORY ONLY. It is never persisted, never
// logged, and never returned to an HTTP caller: `ai_saran.masukan_json` keeps
// COUNTS per class and a hash of the prompt, which proves what was sent without
// putting a second copy of an applicant's identifiers in a table nobody expects
// to find them in.
//
// WHY THE PATTERNS LOOK PARANOID ABOUT SEPARATORS
// Indonesian documents write money as `1.000.000.000` and phone numbers as
// `0812-3456-7890`. A phone pattern that allows a dot between groups therefore
// matches a billion rupiah, and the assistant would hand the Maker a
// placeholder where the loan amount should be. So: dots are never accepted as
// separators inside a phone number, only spaces and hyphens; and the digit
// catch-all requires a CONSECUTIVE run, which an amount with separators can
// never produce. `./ai-redaksi.test.ts` pins both directions with explicit
// fixtures, including the billion-rupiah case that motivated the rule.

/** Classes, in the order they are applied. */
export const KELAS_REDAKSI = ["EMAIL", "NPWP", "NIK", "TELP", "NOMOR"] as const;

export type KelasRedaksi = (typeof KELAS_REDAKSI)[number];

interface Aturan {
  kelas: KelasRedaksi;
  /** More than one shape per class where the class genuinely has more than one. */
  pola: readonly RegExp[];
}

/**
 * ORDER IS NOT ARBITRARY. The specific classes run before the catch-all digit
 * run, or a NIK would be swallowed as `[[NOMOR_n]]` and the class counts stored
 * in `ai_saran` would stop meaning anything.
 */
const ATURAN: readonly Aturan[] = [
  {
    kelas: "EMAIL",
    // Deliberately not RFC-complete. A permissive pattern removes MORE, and
    // removing more is the safe direction to be wrong in.
    pola: [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  },
  {
    kelas: "NPWP",
    // The canonical punctuated form only. A bare 15- or 16-digit run is caught
    // by NIK or by the digit catch-all below, so nothing is missed; matching
    // bare runs HERE would misclassify long amounts, because the hyphen is the
    // only character that tells an NPWP apart from `1.234.567.890.123`.
    pola: [/\b\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}\b/g],
  },
  {
    kelas: "NIK",
    pola: [/\b\d{16}\b/g],
  },
  {
    kelas: "TELP",
    pola: [
      // Mobile, written as one run: 08xxxxxxxxx, 628xxxxxxxxx, +628xxxxxxxxx.
      /(?:\+62|\b62|\b0)[\s-]?8\d{7,11}\b/g,
      // Mobile, written in groups. Spaces and hyphens only, NEVER a dot: a dot
      // is the thousands separator and this is the pattern that would otherwise
      // eat an amount.
      /(?:\+62|\b62|\b0)[\s-]?8\d{1,3}[\s-]\d{3,4}[\s-]\d{3,5}\b/g,
      // Landline: area code then a consecutive subscriber run.
      /\b0\d{2,3}[\s-]?\d{6,8}\b/g,
    ],
  },
  {
    kelas: "NOMOR",
    // Any remaining CONSECUTIVE run of ten or more digits is an identifier, not
    // an amount: a bank account, a KK number, an NIB. An amount that long is
    // written with separators in every document this system sees, and one that
    // is not still round-trips, because the model echoes the placeholder and
    // `rehidrasi` puts the digits back before the value is validated.
    pola: [/\b\d{10,}\b/g],
  },
];

export interface HasilRedaksi {
  /** The text as it will be sent. Contains placeholders, never an identifier. */
  teks: string;
  /** placeholder -> the original string it replaced. In memory only. */
  peta: ReadonlyMap<string, string>;
  /** How many identifiers were removed, per class. Safe to persist. */
  jumlah: Readonly<Record<string, number>>;
}

/**
 * A placeholder shape a model reproduces reliably and that cannot occur in a
 * scanned document by accident. Double square brackets rather than curly
 * braces, because the answer is JSON and braces invite the model to close them.
 */
function placeholder(kelas: KelasRedaksi, n: number): string {
  return `[[${kelas}_${n}]]`;
}

/**
 * Removes every identifier this module refuses to send, returning the text to
 * send plus the map that puts the originals back.
 *
 * The same original always gets the SAME placeholder within one call, so a
 * document that repeats a NIK does not teach the model there are two people.
 */
export function redaksiDokumen(teks: string): HasilRedaksi {
  const peta = new Map<string, string>();
  const kePlaceholder = new Map<string, string>();
  const jumlah: Record<string, number> = {};
  let keluar = teks;

  for (const { kelas, pola } of ATURAN) {
    let urut = 0;
    for (const literal of pola) {
      // A fresh RegExp per pass: the module-level literals carry `g`, and `g`
      // regexes are stateful. Sharing one across requests would make a result
      // depend on what the PREVIOUS request happened to match.
      const re = new RegExp(literal.source, literal.flags);
      keluar = keluar.replace(re, (cocok) => {
        const sudah = kePlaceholder.get(cocok);
        if (sudah) return sudah;
        urut += 1;
        const tanda = placeholder(kelas, urut);
        kePlaceholder.set(cocok, tanda);
        peta.set(tanda, cocok);
        return tanda;
      });
    }
    if (urut > 0) jumlah[kelas] = urut;
  }

  return { teks: keluar, peta, jumlah };
}

/**
 * Puts the originals back into a string the model returned.
 *
 * A placeholder the map does not know is left EXACTLY AS IT IS rather than
 * blanked: a model that invents `[[NIK_9]]` must produce a visibly wrong field
 * on the Maker's screen, not a plausible empty one. This function does not
 * decide whether a value is good -- ./ekstraksi.ts does, and it has to be able
 * to see the fabrication in order to refuse it.
 */
export function rehidrasi(teks: string, peta: ReadonlyMap<string, string>): string {
  if (peta.size === 0) return teks;
  return teks.replace(/\[\[[A-Z]+_\d+\]\]/g, (tanda) => peta.get(tanda) ?? tanda);
}

/**
 * True when `teks` still carries something this module promised not to send.
 *
 * ./ekstraksi.ts runs this on the FINAL prompt string, immediately before the
 * call, so the promise is checked against what actually goes out rather than
 * against what the redactor believes it produced. A prompt that fails this is
 * not sent at all, and the extraction fails open instead.
 */
export function masihMengandungIdentitas(teks: string): boolean {
  for (const { pola } of ATURAN) {
    for (const literal of pola) {
      if (new RegExp(literal.source, literal.flags.replace("g", "")).test(teks)) return true;
    }
  }
  return false;
}

/**
 * Carbon RFID price-tag ZPL builder.
 *
 * Direct port of `carbon-gen/lib/rfid.ts` so a tag printed from
 * Carbon WMS commission renders identical to one generated through
 * the Carbon Studio (https://app.shopcarbon.com/studio/rfid-price-tag).
 * Pre-1.2.48 the WMS shipped a different layout (single-row name,
 * UPC barcode at the bottom, no size/price column) — that's the file
 * the user pulled into a viewer and rejected as "not how my label
 * layout looks".
 *
 * Fields filled at print time:
 *   • TALLA/SIZE column: per-tag size + a horizontal sizes range row
 *   • UPC text (human readable, no barcode of UPC — barcode is of SKU)
 *   • Description split into two vertical lines (carbon-gen layout
 *     puts the matrix description in two rotated columns)
 *   • Color
 *   • Code 128 barcode in VERTICAL orientation (^BCB) of the custom SKU
 *   • SKU text
 *   • Retail price
 *   • Sizes-available column (e.g. "XS, S, M, L")
 *
 * EPC encoding uses ^RB + ^RFW,E (decimal triplet) — the bit-pack
 * scheme the printer applies must match carbon-gen exactly so any
 * downstream reader/auditor that decodes by carbon-gen rules sees
 * the same SGTIN-96 layout.
 */

// 6.5 × 5 cm physical label stock on the ZD500R at 300 DPI. The printer's
// own configured media print width is 812 dots (ezpl.print_width) — the
// earlier 780 left a blank ~32-dot strip on the right of the tag. Gap-to-gap
// calibrated label length is 624 dots. Verified on-printer 2026-06-01.
export const LABEL_WIDTH_DOTS = 812;
export const LABEL_HEIGHT_DOTS = 624;
export const PRINTER_DPI = 300;

export type CarbonTagSettings = {
  companyPrefix: number;
  companyPrefixBits: number;
  itemNumberBits: number;
  serialBits: number;
  printerIp: string;
  printerPort: number;
  labelWidthDots: number;
  labelHeightDots: number;
  labelShiftX: number;
  labelShiftY: number;
};

export const DEFAULT_CARBON_TAG_SETTINGS: CarbonTagSettings = {
  // Carbon Jeans tenant prefix — hex F0A0B = decimal 985611. Matches
  // tenant_epc_config.prefix_hex and the value envCompanyPrefix()
  // returns server-side. The prior 1044991 (hex FF1FF) was a placeholder
  // that, if it ever leaked into a printed tag, would have stamped the
  // wrong prefix and made every commissioned EPC fail the formula filter.
  companyPrefix: 985611,
  companyPrefixBits: 20,
  itemNumberBits: 40,
  serialBits: 36,
  printerIp: "192.168.1.3",
  // Browser print flow uses Zebra web print endpoint (/pstprnt) on HTTP port 80.
  printerPort: 80,
  labelWidthDots: LABEL_WIDTH_DOTS,
  labelHeightDots: LABEL_HEIGHT_DOTS,
  // Whole-label centering on the physical media (so the design sits centered
  // once the operator rotates the tag 90°). labelShiftX → ^LS (NEG = right),
  // labelShiftY → ^LT (POS = down). Dialed in on-printer 2026-06-01 for the
  // 812×624 media. NOTE: the "ending line" (rightmost divider, ^FO775) and
  // ^LS are coupled — if ^LS changes, shift the ending-line x by the same
  // amount to keep it at the right edge.
  labelShiftX: -32, // right
  labelShiftY: 24, // down
};

export type CarbonTagInput = {
  itemName: string;
  color: string;
  size: string;
  upc: string;
  customSku: string;
  retailPrice: string;
  /** Comma-separated sizes-available column on the right. e.g. "XS, S, M, L". Optional. */
  sizesAvailable?: string;
};

const COMMON_SIZES = new Set([
  "XS", "S", "M", "L", "XL", "XXL", "XXXL",
  "2XL", "3XL", "4XL", "5XL",
  "OS", "ONESIZE",
]);

// Natural garment-size order for the sizes-run column. The SQL feeding this
// column uses `ORDER BY size`, which sorts ALPHABETICALLY (L, M, S, XL, XS,
// XXL, XXXL) — wrong for humans. This table ranks the common alpha sizes so
// the strip prints XS S M L XL XXL XXXL. Aliases (2XL≡XXL, etc.) share a rank.
const ALPHA_SIZE_RANK: Record<string, number> = {
  XXS: 0,
  XS: 1,
  S: 2,
  M: 3,
  L: 4,
  XL: 5,
  XXL: 6, "2XL": 6,
  XXXL: 7, "3XL": 7,
  XXXXL: 8, "4XL": 8,
  XXXXXL: 9, "5XL": 9,
  OS: 100, ONESIZE: 100,
};

const MULTI_WORD_COLORS = new Set([
  "OFF WHITE",
  "DARK BLUE",
  "LIGHT BLUE",
  "DARK GREY",
  "LIGHT GREY",
  "DARK GRAY",
  "LIGHT GRAY",
  "ARMY GREEN",
  "ROYAL BLUE",
  "NAVY BLUE",
  "HOT PINK",
  "BABY PINK",
  "BABY BLUE",
]);

export function sanitizeZpl(value: unknown): string {
  return String(value ?? "")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/[\^~]/g, "-")
    .trim();
}

export function epcBitTotal(s: CarbonTagSettings): number {
  return s.companyPrefixBits + s.itemNumberBits + s.serialBits;
}

function mask(bits: number): bigint {
  return (BigInt(1) << BigInt(bits)) - BigInt(1);
}

function fnv1a64(input: string): bigint {
  let hash = BigInt("0xcbf29ce484222325");
  const prime = BigInt("0x100000001b3");
  const max64 = BigInt("0xffffffffffffffff");
  const bytes = new TextEncoder().encode(String(input));
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & max64;
  }
  return hash;
}

export function deriveItemNumber(systemId: string, bits = 40): bigint {
  const normalized = String(systemId || "").trim();
  if (!normalized) {
    throw new Error("Lightspeed System ID is required.");
  }
  if (/^\d+$/.test(normalized)) {
    return BigInt(normalized) & mask(bits);
  }
  return fnv1a64(normalized) & mask(bits);
}

function toPaddedHex(value: bigint, totalBits = 96): string {
  const hexChars = Math.ceil(totalBits / 4);
  return value.toString(16).toUpperCase().padStart(hexChars, "0");
}

export function buildEpc(opts: {
  companyPrefix: number;
  companyPrefixBits?: number;
  itemNumber: bigint;
  itemNumberBits?: number;
  serialNumber: number;
  serialBits?: number;
}): { epcHex: string; epcDecimal: string } {
  const cpBits = opts.companyPrefixBits ?? 20;
  const itemBits = opts.itemNumberBits ?? 40;
  const serialBits = opts.serialBits ?? 36;
  const cp = BigInt(opts.companyPrefix);
  const item = BigInt(opts.itemNumber);
  const serial = BigInt(opts.serialNumber);
  if (cp > mask(cpBits)) throw new Error(`Company prefix exceeds ${cpBits} bits.`);
  if (item > mask(itemBits)) throw new Error(`Item number exceeds ${itemBits} bits.`);
  if (serial > mask(serialBits)) throw new Error(`Serial exceeds ${serialBits} bits.`);
  const epcValue =
    (cp << BigInt(itemBits + serialBits)) |
    (item << BigInt(serialBits)) |
    serial;
  return {
    epcHex: toPaddedHex(epcValue, 96),
    epcDecimal: epcValue.toString(10),
  };
}

/** Greedy whole-word wrap: pack words into lines of at most `max` chars,
 *  never splitting a word. */
function greedyWrap(words: string[], max: number): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  for (const w of words) {
    const cand = [...cur, w].join(" ");
    if (cur.length && cand.length > max) {
      out.push(cur.join(" "));
      cur = [w];
    } else {
      cur.push(w);
    }
  }
  if (cur.length) out.push(cur.join(" "));
  return out;
}

/**
 * Box-4 item-name layout (tuned on-printer 2026-06-01). Strips color/size
 * words from the name, then:
 *   • fits on ONE centered row (font 40) when ≤16 chars, at x324
 *   • else greedy-wraps to TWO rows (font 40, ≤16 each) at x294/354
 *   • else (won't fit 2 rows) drops to font 36 and uses THREE rows
 *     (≤18 each) at x284/324/364
 * All rows centered horizontally (^FB…,C) and anchored at y575.
 */
function layoutItemName(
  name: string,
  color: string,
  size: string,
): { rows: string[]; font: number; xs: number[] } {
  const remove = new Set(
    [sanitizeZpl(color), sanitizeZpl(size)].join(" ").toUpperCase().split(/\s+/).filter(Boolean),
  );
  const words = sanitizeZpl(name)
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !remove.has(w));
  if (words.length === 0) return { rows: ["ITEM"], font: 40, xs: [324] };
  const full = words.join(" ");
  if (full.length <= 16) return { rows: [full], font: 40, xs: [324] };
  const r2 = greedyWrap(words, 16);
  if (r2.length <= 2) return { rows: r2, font: 40, xs: [294, 354] };
  const r3 = greedyWrap(words, 18);
  const rows = r3.length <= 3 ? r3 : [r3[0], r3[1], r3.slice(2).join(" ")];
  return { rows, font: 36, xs: [284, 324, 364] };
}

/** Box-8 size-run auto-shrink: pick the largest font ≤48 whose estimated
 *  Arial width fits the ^FB550 block (~530 usable), nudging x up as the
 *  glyph shrinks so the strip stays vertically centered. */
function box8Layout(text: string): { font: number; x: number } {
  const em = [...text].reduce((a, c) => a + (c === " " ? 0.278 : 0.556), 0);
  const font = Math.min(48, Math.max(20, Math.floor(530 / Math.max(em, 1))));
  const x = Math.round(756 - (48 - font) * 0.5);
  return { font, x };
}

/** Box-6 barcode is Code 93 at ^BY3 — length grows with the SKU. Center it
 *  in the content height (y64..541) so short/long SKUs stay balanced. */
function barcodeStartY(sku: string): number {
  const lengthDots = (9 * sku.length + 37) * 3; // Code 93 module count × ^BY3
  return Math.max(30, Math.round(64 + (477 - lengthDots) / 2));
}

export function inferSizeFromDescription(description: string): string {
  const tokens = sanitizeZpl(description).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";
  const tail = tokens[tokens.length - 1].toUpperCase();
  if (COMMON_SIZES.has(tail)) return tail;
  if (/^\d{1,3}(\.\d+)?$/.test(tail)) return tail;
  return "";
}

export function inferColorFromDescription(description: string, inferredSize: string): string {
  const tokens = sanitizeZpl(description).split(/\s+/).filter(Boolean);
  if (tokens.length < 1) return "";
  const upper = tokens.map((t) => t.toUpperCase());
  const inferredSizeUpper = String(inferredSize || "").toUpperCase();
  const lastIdx = upper.length - 1;
  const last = upper[lastIdx];
  const secondLast = upper[lastIdx - 1] || "";
  if (inferredSizeUpper && last === inferredSizeUpper) {
    if (secondLast && upper.length >= 3) {
      const thirdLast = upper[lastIdx - 2] || "";
      const pair = `${thirdLast} ${secondLast}`.trim();
      if (MULTI_WORD_COLORS.has(pair)) {
        return tokens[lastIdx - 2] && tokens[lastIdx - 1]
          ? `${tokens[lastIdx - 2]} ${tokens[lastIdx - 1]}`
          : tokens[lastIdx - 1] || "";
      }
    }
    return tokens[lastIdx - 1] || "";
  }
  if (secondLast) {
    const pair = `${secondLast} ${last}`.trim();
    if (MULTI_WORD_COLORS.has(pair)) {
      return `${tokens[lastIdx - 1]} ${tokens[lastIdx]}`;
    }
  }
  return tokens[lastIdx] || "";
}

function normalizeSizesColumn(value: string): string {
  const tokens = sanitizeZpl(value)
    .toUpperCase()
    .split(/[,/| ]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
  }
  // Operator preference (May 2026): no commas in the size-run strip —
  // just space-separated tokens for cleaner visual scanning.
  if (unique.length === 0) return "XS S M L";

  // Sort into natural size order (XS S M L XL XXL XXXL …) rather than the
  // alphabetical order the SQL DISTINCT…ORDER BY produced. Numeric sizes
  // (e.g. jeans 28/30/32) sort ascending; recognised alpha sizes use the
  // rank table; anything unrecognised keeps its incoming order, last.
  const rankKey = (s: string): [number, number] => {
    if (/^\d+(\.\d+)?$/.test(s)) return [0, Number.parseFloat(s)];
    const r = ALPHA_SIZE_RANK[s];
    if (r !== undefined) return [1, r];
    return [2, unique.indexOf(s)];
  };
  unique.sort((a, b) => {
    const ka = rankKey(a);
    const kb = rankKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1];
  });
  return unique.join(" ");
}

/**
 * Build a single Carbon price-tag ZPL. The output layout matches the
 * external label-editor ERB template (vertical columns, ^GB graphic boxes,
 * ^FT/^AKB rotated text, ^BCB vertical Code 128 of the SKU, ^RFW,E
 * decimal-triplet EPC encoding).
 */
export function generateCarbonTagZpl(opts: {
  input: CarbonTagInput;
  settings: CarbonTagSettings;
  epcWrite: { companyPrefix: number; itemNumber: number; serialNumber: number };
}): string {
  const { input, settings, epcWrite } = opts;
  const safeColor = sanitizeZpl(input.color).toUpperCase();
  const inferredSize = inferSizeFromDescription(input.itemName);
  const safeSize = (sanitizeZpl(input.size) || inferredSize || "").toUpperCase();
  const safeColorResolved = (
    safeColor || inferColorFromDescription(input.itemName, safeSize)
  ).toUpperCase();
  const safeUpc = sanitizeZpl(input.upc).toUpperCase();
  const safeSku = sanitizeZpl(input.customSku).toUpperCase();
  // Integer dollars (truncated) — matches the operator's $<price.to_i> format.
  const safePrice = String(Math.trunc(Number.parseFloat(sanitizeZpl(input.retailPrice)) || 0));
  const safeSizes = normalizeSizesColumn(input.sizesAvailable ?? "");
  const name = layoutItemName(input.itemName, safeColorResolved, safeSize);
  const nameLines = name.rows
    .map((r, i) => `^FT${name.xs[i]},575^AKB,${name.font}^FB550,1,0,C^FD${r}^FS`)
    .join("\n");
  const b8 = box8Layout(safeSizes);
  const bcY = barcodeStartY(safeSku);
  const epcLength = epcBitTotal(settings);

  // Carbon RFID price-tag — final layout dialed in on-printer 2026-06-01
  // (see project_zd500r_font_and_calibration_2026_06_01 memory). Fonts:
  // K=Arial, B=Arial heavy bold (ARI000), M=Liberation Sans Bold uploaded as
  // E:LSB3.TTF via BINARY ~DY (ASCII-hex upload stores but won't render).
  // ^PR2 slows the print so the thin Code 93 bars come out crisp on thermal.
  // Box 6 barcode = Code 93 (^BAB) of the FULL SKU incl. letters (laser /
  // red-light scannable), centered by length. EPC via ^RB + ^RFW,E decimal
  // triplet (printer bit-packs (cp<<76)|(item<<36)|serial — matches
  // generateSGTIN96). REQUIRES E:LSB3.TTF on the target printer, else box 3
  // (UPC) and box 7 (price) render blank.

  return `^XA
^CI28
^PW${settings.labelWidthDots}
^LL${settings.labelHeightDots}
^MD20
^PR2
^LH0,0
^LS${settings.labelShiftX}
^LT${settings.labelShiftY}
^CWK,E:ARIAL.TTF
^CWB,E:ARI000.TTF
^CWM,E:LSB3.TTF
^FO15,86^GB410,427,2^FS
^FO64,84^GB0,423,3^FS
^FO188,87^GB0,425,3^FS
^FO247,87^GB0,425,3^FS
^FO368,87^GB0,425,3^FS
^FO593,86^GB107,426,3^FS
^FO775,64^GB0,477,3^FS
^FT54,497^AKB,38,^FDTALLA/SIZE^FS
^FT161,529^AKB,100^FB515,1,0,C^FD${safeSize}^FS
^FT232,575^AMB,44^FB550,1,0,C^FD${safeUpc}^FS
${nameLines}
^FT413,559^AKB,36^FB550,1,0,C^FD${safeColorResolved}^FS
^FO436,${bcY}^BY3,2^BAB,112,N,N^FD${safeSku}^FS
^FT581,559^AKB,38^FB550,1,0,C^FD${safeSku}^FS
^FT662,559^AMB,58^FB550,1,0,C^FD$${safePrice}^FS
^FT${b8.x},567^AKB,${b8.font}^FB550,1,0,C^FD${safeSizes}^FS
^RB${epcLength},${settings.companyPrefixBits},${settings.itemNumberBits},${settings.serialBits}^FS
^RFW,E^FD${epcWrite.companyPrefix},${epcWrite.itemNumber},${epcWrite.serialNumber}^FS
^PQ1,0,1,Y
^XZ`;
}

/** Concatenate per-label ZPL into one batch the printer streams sequentially. */
export function generateCarbonTagBatch(zpls: string[]): string {
  return zpls.join("\n");
}

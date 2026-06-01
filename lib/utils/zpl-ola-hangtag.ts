/**
 * Carbon "OLA" commissioning hang-tag — ZPL builder.
 *
 * Faithful port of the live external-editor template
 * `label-backups/ola-commissioning-label/external-editor-alu-code39-2026-05-28.zpl.erb`:
 * rotated `^AKB` cells, Code 39 barcode (`^B3B`) of the ALU/SKU, the `^GB`
 * cell grid, and field-based RFID encode (`^RB` / `^RFW,E`). The description
 * word-wrap mirrors the template's Ruby logic (drops the color/size words,
 * 2 lines, ≤15 chars).
 *
 * Used by the Print Tags page for BOTH the on-screen preview (so preview == print)
 * and the actual print payload. The ONLY difference between an RFID tag and a
 * non-RFID tag is the chip-encode block (`^RB` / `^RFW,E`), which is omitted
 * when `includeRfid` is false. Everything else — text, barcode, grid, geometry —
 * is identical.
 */

export type OlaLabelItem = {
  /** Lightspeed ALU — printed as the Code 39 barcode + human-readable line. */
  sku: string;
  /** @item_attr4 — size (the large cell). */
  size?: string | null;
  /** @item_attr3 — color. */
  color?: string | null;
  /** @retail_price — printed as `$<int>`. */
  price?: number | string | null;
  /** @item_upc — style/UPC cell. */
  upc?: string | null;
  /** @item_description — word-wrapped to 2 lines after dropping color/size words. */
  description?: string | null;
  /** Lightspeed system ID — the RFID item reference (40-bit). */
  sysid: string | number;
  /** @item_attr12 — trailing cell; not synced to WMS, blank by default. */
  attr12?: string | null;
};

export type OlaZplOptions = {
  /** Include the chip-encode block (`^RB` + `^RFW,E`). RFID tags = true, non-RFID = false. */
  includeRfid?: boolean;
  /** 20-bit GS1 company prefix for the RFID encode (Carbon = 985611). */
  companyPrefix?: number;
};

const DEFAULT_COMPANY_PREFIX = 985_611;

/** Strip ZPL control chars, collapse newlines, cap length (matches the REFTAG sanitizer). */
function sanitize(text: string | null | undefined): string {
  if (!text) return "";
  return String(text).replace(/[\^~]/g, "").replace(/\n|\r/g, " ").substring(0, 40);
}

/**
 * Reproduce the ERB description word-wrap: split the description into words,
 * remove any word that appears in the color (attr3) or size (attr4), then pack
 * into 2 lines of ≤15 characters each.
 */
export function olaDescriptionLines(
  description: string | null | undefined,
  color: string | null | undefined,
  size: string | null | undefined,
): [string, string] {
  let words = sanitize(description).split(" ").filter(Boolean);
  for (const attr of [color, size]) {
    if (!attr) continue;
    for (const w of String(attr).split(" ").filter(Boolean)) {
      words = words.filter((x) => x !== w);
    }
  }
  const charsPerLine = 15;
  const lines: string[] = [];
  for (let n = 0; n < 2; n += 1) {
    let line = "";
    let temp = "";
    for (const r of words) {
      temp += `${r} `;
      if (temp.length > charsPerLine) break;
      line = temp;
    }
    lines.push(line.trim());
    const consumed = line.split(" ").filter(Boolean).length;
    words = words.slice(consumed);
    if (words.length === 0) break;
  }
  return [lines[0] ?? "", lines[1] ?? ""];
}

/** Build the ZPL for a single hang-tag at the given serial. */
export function buildOlaHangtagZpl(
  item: OlaLabelItem,
  serial: number,
  opts: OlaZplOptions = {},
): string {
  const includeRfid = opts.includeRfid ?? true;
  const cp = opts.companyPrefix ?? DEFAULT_COMPANY_PREFIX;

  const [l0, l1] = olaDescriptionLines(item.description, item.color, item.size);
  const alu = sanitize(item.sku);
  // The barcode Y origin shifts for the 13-char ALU (matches the ERB ternary).
  const barcodeY = alu.length === 13 ? 95 : 125;
  const price = Math.trunc(Number(item.price) || 0);

  // Chip-encode block — present only on RFID tags. Field-based GS1 encode:
  // ^RB <epc_len>,<cp_bits>,<item_bits>,<serial_bits> then ^RFW,E with the values.
  const rfidBlock = includeRfid
    ? `^RB96,20,40,36^FS
^RFW,E^FD${cp},${item.sysid},${serial}^FS

`
    : "";

  return `^XA
^MD20
^CWK,E:ARIAL.TTF

^FT73,490^AKB,38,^FDTALLA/SIZE^FS
^FT194,522^AKB,134^FB515,1,0,C^FD${sanitize(item.size)}^FS
^FT253,590^AKB,36^FB600,1,0,C^FD${sanitize(item.upc)}^FS
^FT313,552^AKB,36^FB550,1,0,C^FD${l0}^FS
^FT373,552^AKB,36^FB550,1,0,C^FD${l1}^FS
^FT432,552^AKB,36^FB550,1,0,C^FD${sanitize(item.color)}^FS
^FO455,${barcodeY}^BY2,3^B3B,N,110,N,N^FD${alu}^FS
^FT600,552^AKB,32^FB550,1,0,C^FD${alu}^FS
^FT687,552^AKB,60^FB550,1,0,C^FD$${price}^FS
^FT765,552^AKB,38^FB550,1,0,C^FD${sanitize(item.attr12)}^FS

^FO34,79^GB410,427,2^FS
^FO83,77^GB0,423,3^FS
^FO325,80^GB0,425,3^FS
^FO387,80^GB0,425,3^FS
^FO612,79^GB107,426,3^FS
^FO783,57^GB0,477,3^FS
^FO266,80^GB0,425,3^FS
^FO207,80^GB0,425,3^FS

${rfidBlock}^PQ1,0,1,Y
^XZ`;
}

/** Build a batch of `qty` hang-tags, serials `startSerial … startSerial+qty-1`. */
export function buildOlaHangtagZplBatch(
  item: OlaLabelItem,
  startSerial: number,
  qty: number,
  opts: OlaZplOptions = {},
): string {
  const out: string[] = [];
  for (let i = 0; i < qty; i += 1) {
    out.push(buildOlaHangtagZpl(item, startSerial + i, opts));
  }
  return out.join("\n");
}

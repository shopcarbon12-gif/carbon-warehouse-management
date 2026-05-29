# OLA commissioning label — backup & restore point

This folder is the **canonical restore point** for the RFID commissioning hang-tag
label as it existed on **2026-05-28**, before any edits.

> Why a standalone backup (not the repo)? This label is an **ERB-templated ZPL**
> rendered by an external/vendor label-design platform reached via
> `https://wms.shopcarbon.com/rfid/commissioning`. It is **not** stored in this
> Git repo — the repo's `/rfid/commissioning` page builds ZPL in TypeScript
> (`lib/utils/zpl-rfid-reftag.ts`, `zpl-carbon-tag.ts`) with no ERB and a
> different settings UI. So this captured copy is the only source of truth for
> restore.

## Files
- `external-editor-alu-code39-2026-05-28.zpl.erb` — **CURRENT live external-editor
  template.** Uses `@alu` (not `@custom_sku`) and **Code 39** (`^B3B`) at `^BY2,3`,
  matching the WMS-printed label. This is what's pasted into the vendor editor now.
- `external-editor-alu-code128-2026-05-28.zpl.erb` — the `@alu` template BEFORE the
  Code 39 switch (Code 128 `^BCB`, `^BY2,2`). Restore point for the `@alu` variant.
- `template-2026-05-28.zpl.erb` — the original `@custom_sku` Code 128 template (verbatim paste).
  - sha256: `765e4d1ddd5fd5ce20e4be6ecd3fae6599473de9d8a4357e96ca0e787f97126f`
  - Note: 4 lines in the original paste had cosmetic *trailing spaces* (after
    `^FS` on the two `lines[...]` rows, and after the two `@item_attr3/4` ruby
    lines). Those are whitespace-only and have no effect on ZPL or Ruby output;
    the functional content here is identical.
- `settings-2026-05-28.md` — Darkness / X-Y position / DPI / Width / Height.
- `preview-and-settings-2026-05-28.png` — screenshot of the live preview + controls.

## RESTORE CONTRACT
When the operator says **"restore the label"**, the target state is EXACTLY:
0. Confirm which template they mean — the live external editor uses the `@alu`
   variant. Default restore for the external editor =
   `external-editor-alu-code128-2026-05-28.zpl.erb` (pre-Code-39 `@alu`), or
   `external-editor-alu-code39-2026-05-28.zpl.erb` if they want the Code 39 state.
   The `@custom_sku` files below are the older original.
1. Replace the platform's label template with the full contents of the chosen file
   (`template-2026-05-28.zpl.erb` for the original `@custom_sku` baseline).
2. Set the print controls back to `settings-2026-05-28.md`:
   - Darkness OFF / 0
   - Control Label Y Pos ON / 50
   - Control Label X Pos ON / -242
   - DPI 300 (12 dpmm), Width 2.63 in, Height 1.92 in
3. Visual result must match `preview-and-settings-2026-05-28.png`.

## Operator constraints carried forward into any edits
- **Do NOT change the font/style.** Keep `^CWK,E:ARIAL.TTF` and the `^AKB` font
  references and sizes exactly as-is.
- Preserve all existing behavior: barcode (`^BCB` Code 128, rotated), RFID
  encode (`^RB` / `^RFW,E`), data mapping (item_attr3/4/12, custom_sku, upc,
  retail_price, description word-wrap), and element positions.

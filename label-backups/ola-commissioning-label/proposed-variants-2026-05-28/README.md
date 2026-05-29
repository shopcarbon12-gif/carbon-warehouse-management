# Proposed Code 39 barcode variants — 2026-05-28

Three candidate templates. Each is a full copy of the backed-up label with
**only the barcode line changed** to Code 39 (`^B3`). Everything else — font,
positions, RFID encode, data mapping — is byte-identical to
`../template-2026-05-28.zpl.erb`. Pick one; the rest can be deleted.

These are PROPOSALS, not the restore point. "Restore the label" still means the
parent folder's `template-2026-05-28.zpl.erb` (Code 128, original).

## The one line that changed (vs. original Code 128)
Original:
```
^FO455,<%= @custom_sku.length.eql?(13) ? '95' : '125' %>^BY2,2^BCB,110,N,N,N^FD<%=@custom_sku%>^FS
```

| File | New barcode line | Behavior |
|------|------------------|----------|
| `A-fit-longest.zpl.erb` | `^FO455,125^BY2,3^B3B,N,110,N,N^FD<%=@custom_sku%>^FS` | Fixed bar width. Real SKU. 14-char fills the column; shorter SKUs are a bit narrower but never overflow. Always scans. **Recommended.** |
| `B-dynamic-width.zpl.erb` | `^FO455,125^BY<%= @custom_sku.length >= 13 ? '1' : '2' %>,3^B3B,N,110,N,N^FD<%=@custom_sku%>^FS` | Real SKU. Thinner bars for long (13–14 char) SKUs, thicker for short — keeps overall length in a tighter band. Coarse (integer bar widths), so "near-uniform," not pixel-perfect. Always scans. |
| `C-pad-to-14.zpl.erb` | `^FO455,125^BY2,3^B3B,N,110,N,N^FD<%= @custom_sku.rjust(14, '0') %>^FS` | Pads SKU to 14 with leading zeros → **pixel-identical width every time.** ⚠️ The barcode then encodes the zeros too — only use if your POS strips leading zeros on scan, or checkout lookups break. Human-readable text still shows the real SKU. |

## Common changes in all three
- `^BCB` (Code 128) → `^B3B` (Code 39, same rotated B orientation).
- Wide-bar ratio raised `^BY…,2` → `^BY…,3` for the bolder Code 39 look.
- Field origin fixed at `^FO455,125` (was a 13-char-vs-other branch) for
  consistent positioning. Bar height kept at `110` (unchanged footprint).
- Interpretation line stays OFF — the human-readable `@custom_sku` is still
  printed separately at `^FT600`.

## Fit check (do this in the platform preview)
Code 39 is ~40% longer than Code 128 for the same data. Preview a **14-char**
SKU in A and C: if the bars run past the box, change the first `^BY` number
from `2` to `1`. If there's empty space, you can raise it for thicker bars.
Optional "wider" lever: the `110` bar-height can go up to ~150 before it reaches
the price box at x=612 (`455 + 150 = 605`).

# Product Details block — live theme 166971539708 (2026-10-11)

Fabric, Care and model height ("Model is 5'8\"", never the size worn) under the
buy button on every product page, in en / es / pt-BR.

- `snippets/carbon-product-details.liquid` — new; reads custom.fabric_composition /
  care_instructions / model_height (definitions created, storefront PUBLIC_READ).
- `templates/product.json` + `product.context.us.json` — custom_liquid block
  `carbon_details` after `buy_buttons` (the US context file must NOT repeat the
  block `type`, Shopify rejects it).
- `sections/main-product.liquid` — the Care Guide side panel shows the product's
  own care when it exists (the generic text said "tumble dry low").

Values are written by lib/server/product-details-sync.ts (Sync ads job, or
`npx tsx scripts/sync-product-details.ts`).

**Undo:** upload the files in `before/` back with themeFilesUpsert and delete the snippet.
**Show the size worn later:** change modelHeightLine() in lib/product-details.ts to
use matrices.model_size_worn, then run the sync.

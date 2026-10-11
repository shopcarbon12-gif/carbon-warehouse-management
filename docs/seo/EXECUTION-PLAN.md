# CARBON SEO — execution plan

**2026-10-11.** This replaces any further spec revisions. Background is in `SEO-ENGINE-V2-SPEC.md` (rev 3). This page answers the rev-3 review (`CARBON-SEO-REV3-REVIEW.md`) and lists what has shipped and what comes next.

## 1. What is live (shipped 2026-10-11)

| Change | Evidence / undo |
|---|---|
| **Repeated or wrong SEO titles fixed** (en/es/pt). 31 products became `Name \| Carbon`, including 4 that carried another product's title. Item names follow the WMS (owner). | `evidence/t1-backup.json`, `fix4-backup.json` |
| **6 product URLs renamed** to match item names, with Shopify's own 301s. Set-partner metafields updated, set-cart test 7/7. | same |
| **Showroom page:** `Place "Florida Mall"` → `ClothingStore "Carbon Showroom"` (address, phone, hours from the page). Title and meta set in 3 languages. | `evidence/theme.liquid.before-2026-10-11` |
| **Product-copy writer** (`lib/seo/claims.ts`, `optimizeCore.ts`). It never states fabric, feel, fit, care, measurements, origin, labels, the logo's shape, "Carbon Jeans" or set contents. The title is built `Name – Descriptor \| Carbon`. No length padding. Tags only added. | `scripts/test-seo-claims.ts` (13 golden cases) |
| **All 570 active products rewritten** with that writer, at the owner's request. Read-back check found 0 claims, 0 doubled titles, 0 lost set banners, 0 removed tags. | `scripts/.seo-bulk/backup-before-2026-10-11.json` (local), `verify.ts` |

The review recommended expanding product rewrites *selectively*, after samples. The owner chose a full rewrite instead. It is fully backed up and reversible per product. Consequence: there is no untreated control group any more (see §5).

## 2. Search Console figures, reconciled

Settings: property `sc-domain:shopcarbon.com`, search type `web`, `dataState: final`, 2026-07-12 → 2026-10-09 (90 days). Every query is paginated to the end with 25k-row pages. Script and output: `evidence/gsc-reconcile.mjs` / `.out.json`.

| Aggregation | Clicks | Impressions | What it is |
|---|---|---|---|
| Property total (no dimensions) = by date | **2,223** | 85,543 | The site total. Use this as the denominator. |
| By page | 2,259 | 117,955 | Page-level counting (Google counts per URL, so it exceeds the property total). |
| By query | 1,221 | 41,919 | Only queries Google discloses. **1,002 clicks (45%) are anonymised.** |
| By query × page | 1,243 | 62,113 | Disclosed query rows only. |
| Branded (contains carbon/shopcarbon), within disclosed queries | 1,164 | 19,933 | |

So the correct statement is: **at least 52% of all clicks (1,164 / 2,223) are branded. 57 are disclosed nonbranded. 45% are unknown.**

- The earlier "95%" was the share of *disclosed* query clicks only. It is withdrawn.
- "1,230 home clicks" summed `/`, `/es` and `/pt` from a page-dimension pull. It is not comparable with the query totals.
- "130 nonbranded product clicks in 16 months" is a count over **observed query × page rows**, not an exhaustive total.
- Common first names (Alex, Andy, Bradley) stay **ambiguous**. Only queries that contain another brand's name ("benjamin black", "alo set") are treated as other-brand intent.

## 3. Archived products — retirement policy

The blanket "archived → collection" rule is withdrawn. Each product is now decided on its own:

| Archived product | Decision |
|---|---|
| `carbon-classic-tee` | **301 → `/products/carbon-classic-t`.** It is the same tee, live with 264 in stock: a genuine replacement. |
| `startdust-denim-jacket` | **404.** There is no equivalent product, so the redirect was removed. |
| `brave-and-wild-top-set` | **404.** The live short set is its partner, not a replacement, so the redirect was removed. A clean 404 also lets the set-cart guard treat the partner as gone. |

The rule going forward:
- 301 only to the same or a genuinely substitutable product.
- Otherwise 404/410.
- A temporarily unavailable product stays live and shows as sold out.

The handle-rename 301s in §1 are the same product, so they stay.

## 4. Merchant Center proof — corrected pass condition

The old step 2 is withdrawn: sending ordinary and structured fields with *identical* text cannot show which field is effective.

The new proof uses one product and is fully reversible:

1. **Distinguishable texts.** The ordinary field keeps today's Shopify text. The structured field gets legitimate alternative wording, a real candidate Shopping title/description. Nothing like `ZZTEST` is ever shown to shoppers.
2. **Configuration under test.** Supplemental `structuredTitle` / `structuredDescription` (`digitalSourceType: TRAINED_ALGORITHMIC_MEDIA`). A primary-source attribute rule removes the ordinary `title` / `description` whenever a structured value exists.
3. **Pass only if the processed product's effective title and description equal the *structured* text.** "Structured retained, no error" is not a pass.
4. **Sync trigger.** Add and then remove a non-customer-facing tag; never change a price.
5. **Then test:** the Spanish listing, `customLabel0` unchanged, a normal Shopify refresh at +24h, and rollback (remove the rule and the supplemental values → the original text returns).
6. If no configuration passes, ask Google Merchant support for the supported setup. No feed-text writes until then.

## 5. Measurement (replaces the pilot design)

- Recent data (2026-08-15 → 10-09, 56 days): **only 32 product pages have ≥ 50 disclosed nonbranded impressions** (median 2). That is far too few for a 40-pair test.
- Every product has now been rewritten, so there is no control group.

**Measurement is therefore a labelled *directional* before/after, not an experiment:**
- **Windows:** equal 28-day windows. Before = 2026-09-13 → 10-10. After = 2026-10-25 → 11-21, skipping 2 weeks for recrawl. Seasonality is reported as an uncontrolled confound, using the same windows in 2025 where data exists.
- **Metrics, all reported side by side:**
  - property-total clicks and impressions;
  - disclosed nonbranded impressions and clicks;
  - Shopping clicks, conversions and cost, separately;
  - organic sessions, add-to-cart, orders and revenue (Shopify).
- **Fixed in advance:** query classification is frozen from the baseline window. Products that sell out stay in the cohort; an availability-adjusted view is shown alongside.
- **No success claim is made from impressions alone.**

## 6. Factual validator — what the live code actually does

- **No composition, measurement, care or origin claim can be published at all.** There is no verified fact store yet, so every percentage, fibre word, unit and "made in" is deleted (`claims.ts`). The reversed-composition case ("2% cotton, 98% elastane") cannot reach the site today.
- **When verified facts arrive:** composition, care, origin and measurements are **rendered verbatim from the structured value** in a "Details" block. Prose may not contain those classes at all. There is no token matching against facts.
- **What the lexicon is:** a screening tool, not a truth validator. Fit guarantees and negation are banned outright rather than "verified".
- **Sets:** copy says only "Pair it with the <partner>". It never says what the purchase includes. The cart behaviour (normal add, solo override, cart price, checkout) gets a manual end-to-end test before any copy describes purchase contents. `test-set-cart-guard.mjs` covers the guard only.

## 7. Product identifiers

- **Owner confirmed (2026-10-11):** every product is CARBON's own private-label product. No supplier GTINs or part numbers exist. The one exception is the gift card (vendor "Givy").
- The 7-digit barcodes are internal style codes and are never sent as GTINs.
- **Plan:** for each variant, send `brand: Carbon` + `mpn: <variant SKU>` (e.g. `1223303A7M`). CARBON is entitled to assign these as the manufacturer.
- **Route:** Shopify's own `mm-google-shopping.mpn` variant metafield, the same namespace the WMS already writes for gender, age_group and condition. It does not use the supplemental source, so it cannot race Sync ads.
- **Test first:** one product, then read back from Merchant Center that `mpn` arrived and what the app now sends as `identifierExists`. Reversible: delete the metafields. Roll out to all variants only after that read-back.

## 8. Implementation contracts for the small build (publish/revert, feed writer)

These are fixed in code and tests, not in more spec:

- **Operation id.** `op_id = {item}:{plan_id}:{direction}:{target}`. Each publish or revert plan gets its own `plan_id`, so a revert can never collide with a publish.
- **One state machine:**
  - item: `approved → publishing → published | partial | conflict`;
  - `published → reverting → reverted | partial_revert | conflict`;
  - every value is in the CHECK constraint, and the tests cover every transition.
- **Dependencies.** A dependent op is `skipped` when its prerequisite is `failed` or `conflict`. "Published" requires a final read-back of every target.
- **Facts migration.** Adds the `performance` class and a `variant_scope text[]` column, with tests.
- **Feed ownership.**
  - The `backfill → seo` takeover is explicit and logged.
  - A remote write is first journalled as `intended`, then marked `done` after the API reply and read-back, so a DB failure after an API success is re-sent instead of being erased.
- **After a revert:** the item's `active_revision_id` becomes the **pre-publish** state, so feed sync never reapplies the reverted revision.
- **Spanish while a translation is pending:** the feed sends Shopify's current Spanish text, with no override, until the Spanish artifact matches the current English.

## 9. Next, in order

| # | Step | Status |
|---|---|---|
| 1 | Reconcile search data and publish one priority list | **Done** (§2). Priority list = step 3. |
| 2 | Wrong titles, showroom, retirement policy | **Done** (§1, §3) |
| 2b | ES/PT check after the owner's Shopify-translator pass: brand never "Carbono/Carbón", glossary, `\| Carbon` suffix | Waiting for the owner. Already seen in Spanish: 486 × "Carbono/Carbón", 24 × "camiseta sin mangas" |
| 3 | Improve 3–5 collections: `jeans-men`, `pants`, `super-skinny-jeans-men`, `matching-sets`, `shorts-1`, `/pages/jeans`. Use recent query intent, stock depth, crawlable links and a short buying guide. Owner approves each. | Next |
| 4 | §4 one-product feed proof → single feed writer → minimal publish/revert (§8) | After 3 |
| 5 | Owner reviews 12 rewritten products; corrections go back into the writer rules | Owner, any time |
| 6 | Directional measurement report (§5) | ~2026-11-22 |

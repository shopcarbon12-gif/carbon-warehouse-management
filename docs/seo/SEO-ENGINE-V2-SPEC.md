# CARBON SEO — Revision 3: Product Content Engine + Business SEO Plan

**Execution is now tracked in `EXECUTION-PLAN.md`** (answers the rev-3 review; corrects §D11 G2, §D7 T2, §D1.2 and §D6).

**Status:** DRAFT rev 3 — nothing implemented. Rev 1 and rev 2 (2026-10-11) were reviewed by Codex (`CARBON-SEO-V2-REVIEW.md`, `CARBON-SEO-REV2-REVIEW.md`). **Part D (rev 3) supersedes the sections it names**; where Part D and A–C disagree, Part D wins. Repo `carbon-warehouse-management` at `main` `2a7cb1c`.
**Scope split (per review):** Part A is the *product content engine*. Part B is the *business SEO plan* the engine is one component of. Part C answers the review line by line.

Brand rules that do not change: the brand is **CARBON / Carbon** (never "Carbon Jeans" as the brand); the hexagon-cluster mark is **the Carbon logo**; Spanish/Portuguese follow through the existing Translate job.

---

## 0. New facts established since rev 1 (verified on live systems)

| # | Fact | How verified |
|---|---|---|
| V1 | **Google Shopping titles come from the Shopify SEO title**, plus the variant: Merchant Center title = `Bradley Jacket - Bradley Jacket DARK BLUE / M`. The doubled-name bug is therefore also in Shopping ads. Rev 3 measurement: **566/567** English listings start with the Shopify SEO title. | `docs/seo/evidence/feed-mapping.py` → `feed-mapping.out.json` (D0) |
| V2 | **Corrected in rev 3.** Merchant Center `description` = the Shopify **SEO meta description** (561/567), *not* the product body (2/567). `structuredTitle` / `structuredDescription` are set on 0 of 7,320 listings. | Same evidence file (D0) |
| V3 | No Search Console access yet: the Google OAuth token has `adwords`, `content`, `tagmanager.*` scopes only (403 on `webmasters/v3/sites`). | tokeninfo + API call |
| V4 | Google Ads API **is** available (developer token + account 737-472-8972) → Keyword Planner historical metrics are usable for demand research now. | Existing `GOOGLE_ADS_*` env, used by Sync ads |
| V5 | The WMS holds **no fibre / care / composition / measurement data** per product (`matrices` has no such columns; `size_grading_measurements` has 2 rows). Non-visual claims have no verified source today. | `information_schema`, row count |
| V6 | Some Shopify gallery images are **Studio-generated** (`…/files/studio-<ts>-<n>.png`). They are renders, not evidence. The original photos live in Studio refs (`studio_matrix_state.item_refs`, R2 `carbon-studio/handoff/…`). | Product media URLs (e.g. River Top Set) |
| V7 | 84 collections, 1 smart, **0 tag-based**; 1,742 distinct tags; theme/app tag usage **not yet audited**. | Admin API |
| V8 | Product JSON-LD is `ProductGroup` (+ BreadcrumbList, Organization); **validity not yet tested** with Google's tools. | Page HTML |

---

# PART A — Product Content Engine

## A1. Goals (revised)

1. Each product page answers the buying questions for that item — what it is, how it looks, how it fits, what it's made of (only when verified) — in the Carbon voice.
2. Titles carry the item type and distinguishing attributes **in natural customer language**, the product name where useful, and the brand.
3. Every factual claim has a recorded source; claims without an allowed source are not written.
4. Nothing reaches Shopify without a human-approved, server-validated revision; every write is backed up, idempotent and revertible.
5. Merchant Center receives AI-written text with the correct AI-content attributes.
6. Demand and page mapping come from data (Part B), not from the attribute combiner alone.

Non-goals unchanged for the engine itself (collections, technical SEO and local are Part B).

## A2. Evidence policy — *superseded in part by D3* (replaces "photos are the source of truth")

Every claim the model may make belongs to a **field class**, and each class has the sources it may come from.

| Field class | Examples | Allowed sources |
|---|---|---|
| `visual` | colour, print/graphic and its wording, distressing, visible pockets/closure kind, neckline, sleeve length, hem, apparent silhouette | `photo_original` (real photos only), `merchant_confirmed` |
| `fit` | regular / slim / relaxed / oversized, rise, length class | `merchant_confirmed`, `catalog`; `photo_original` only as **"looks …"** wording ("a relaxed, straight look") — never "true to size", "stretch" |
| `material` | fibre %, fabric weight, stretch, softness, breathability | `catalog` / `supplier` / `merchant_confirmed` **only** |
| `care` | washing instructions | `catalog` / `supplier` / `merchant_confirmed` **only** |
| `measurement` | inseam, rise, garment length, chest width | `size_grading` (WMS measured), `supplier`, `merchant_confirmed` |
| `origin` | country of manufacture | `catalog` / `supplier` / `merchant_confirmed` |
| `set_composition` | included pieces, sold together/separately | WMS `matrices.is_set` + `carbon_set.partners` metafield |

**Never allowed as a source:** previous description text (`legacy_copy`), Studio-generated renders, the model's own `observed` list as verification of itself.

### A2.1 Sources in data

New table (§A9) `product_facts`: one row per (product, field, value, source, verified_by, verified_at). Filled from:
- `merchant_confirmed` — new "Product facts" section in Matrix → SEO tab (material, care, fit, inseam/rise/length, origin), each saved with the user and time.
- `size_grading` — imported from `size_grading_measurements` when present.
- `supplier` — optional CSV import (columns: sku/upc, field, value).
- `catalog` — reserved for future WMS columns.

Legacy copy is shown to the reviewer as **"Old description said: 100 % cotton — unverified"** with a one-click "Confirm as fact" (→ `merchant_confirmed`). It is never passed to the model as usable.

### A2.2 Original photos only

`loadEvidenceImages(product)`:
1. Prefer the Studio item refs for the product (`studio_matrix_state.item_refs`, views general/front/back — real phone/camera photos), fetched via `downloadStorageObject`.
2. Then Shopify media **excluding** `/files/studio-\d+-\d+\.(png|jpe?g|webp)` and any media whose alt or filename marks it as a render.
3. Up to 6 images, distinct views first. Each image gets an `evidenceId` (`ev1…ev6`) recorded in the proposal.

### A2.3 Claim checking — *superseded in part by D3* (deterministic + model)

The model returns claims, not just prose (schema §A5): `claims: [{ id, text, fieldClass, source: "ev2" | "fact:<id>" }]`. The copy may only use claims by id.

`validateClaims()`:
- `fieldClass ∈ {material, care, measurement, origin}` → `source` must be `fact:<id>` of a matching verified `product_facts` row, else **blocker**.
- `visual` → `source` must be an `evN` that exists.
- A regex sweep over the final copy for unsupported claim words when no matching fact exists: `/\b(\d{1,3}\s?%|cotton|polyester|elastane|spandex|linen|wool|leather|stretch(y)?|soft|breathable|durable|machine wash|hand wash|true to size|runs (small|large))\b/i` → **blocker** unless a fact of that class is present. ("leather patch" is allowed when a `visual` claim covers it — sweep uses claim spans.)

This does not make the model's vision infallible; it makes every non-visual claim traceable and every visual claim reviewable against a named photo in the review UI (the reviewer sees `ev2` beside the sentence).

## A3. Copy format (flexible)

Replaces the fixed 220–650 chars / 3–4 bullets / mandatory styling line.

```
<p>{intro: 1–3 sentences — what it is + standout visible details}</p>
[<p>{styling line}</p>]                          ← optional; only when it adds information
[<ul>{0–5 key details}</ul>]                       ← only real details; none is fine for a simple item
[<h3>Details & fit</h3><ul>{verified facts}</ul>]  ← rendered from product_facts only (material, care, inseam, rise, length, origin)
```

- Length follows evidence: a bracelet may be 1–2 sentences; a detailed dress more.
- Advisory targets (warnings, not blockers): intro ≥ 1 sentence; total text 80–900 chars.
- Measurements are **allowed** in "Details & fit" when verified (`measurement` facts, with unit and size, e.g. "Inseam 9 in (size 32)"). Size *availability* lists are still not written (variants show sizes).
- Labels/patches/inside tags remain out of copy unless the label **is** the design (a large printed patch that is the main visual feature) — then it is a `visual` claim like any print.

## A4. Titles and meta (revised) — *superseded in part by D2*

- **Title (SEO title, which also becomes the Shopping title — V1):** compact, natural, chosen per item:
  - Pattern P1 (attribute-led): `Men's Black Ripped Denim Shorts – Alex | Carbon`
  - Pattern P2 (name-led, when the name has branded demand per Part B data): `Alex Denim Shorts – Men's Black Ripped | Carbon`
  - Pattern P3 (graphic/name-is-the-design): `Memories Graphic T-Shirt | Carbon`
  The pattern is chosen from Part B's query map (`page_targets.title_pattern`), default P1.
- Never repeat the name or the category noun (fixes rev 1's "Denim Shorts … Denim Shorts").
- 60 chars / 155 chars are **editing targets** (warning above them, never a blocker); a good 95-char meta does not fail.
- Shopping variant suffix: the Shopify app appends ` COLOUR / SIZE` — keep the SEO title ≤ ~45 chars when possible so the Shopping title stays readable (warning only).

`finishTitle()` (rewritten):

```ts
export function finishTitle(i: { name: string; gender: Gender; colour?: string; style: string[]; noun: string; pattern: "P1" | "P2" | "P3" }): string {
  const g = i.gender === "men" ? "Men's" : i.gender === "women" ? "Women's" : "";
  const nameWords = new Set(i.name.toLowerCase().split(/\s+/));
  const attrs = [i.colour, ...i.style].filter(Boolean).map(cap).filter((w) => !nameWords.has(w.toLowerCase()));
  const nounInName = i.name.toLowerCase().includes(i.noun.toLowerCase());
  const shortName = nounInName ? i.name.replace(new RegExp(`\\s*${escapeRe(i.noun)}\\s*$`, "i"), "").trim() || i.name : i.name;
  const built =
    i.pattern === "P1" ? [`${[g, ...attrs, capNoun(i.noun)].filter(Boolean).join(" ")}`, shortName] :
    i.pattern === "P2" ? [i.name, [g, ...attrs].filter(Boolean).join(" ")] :
                         [i.name];
  const title = built.filter(Boolean).join(" – ") + " | Carbon";
  return dedupeWords(title); // removes an exact repeated word run, e.g. "Denim Shorts … Denim Shorts"
}
// finishTitle({name:"Alex Denim Shorts", gender:"men", colour:"black", style:["ripped"], noun:"denim shorts", pattern:"P1"})
//   → "Men's Black Ripped Denim Shorts – Alex | Carbon"
```

## A5. Prompt and output (revised)

System prompt keeps rev 1's voice/brand rules and adds the evidence policy: *"You may only state a material, care, measurement, origin or fit claim when it is listed under VERIFIED FACTS with an id. Visual claims must cite the photo id they come from."* The styling line becomes optional; "aim for a score" language is gone; no length padding instruction exists anywhere.

Output (zod):

```ts
const Claim = z.object({ id: z.string(), text: z.string().max(200), fieldClass: z.enum(["visual","fit","material","care","measurement","origin","set_composition"]), source: z.string() });
const Out = z.object({
  observations: z.array(z.object({ evidenceId: z.string(), fact: z.string() })).min(3).max(25),
  claims: z.array(Claim).min(2).max(20),
  attributes: z.object({ colour: z.string().max(30), style: z.array(z.string().max(20)).max(2), noun: z.string().max(40) }),
  intro: z.object({ text: z.string().min(30).max(600), claimIds: z.array(z.string()) }),
  styling: z.object({ text: z.string().max(220), claimIds: z.array(z.string()) }).nullable(),
  details: z.array(z.object({ text: z.string().max(90), claimIds: z.array(z.string()) })).max(5),
  meta: z.string().min(60).max(220),
  alts: z.array(z.object({ evidenceId: z.string(), alt: z.string().min(10).max(160) })),
});
```

The renderer builds HTML only from `intro/styling/details` + `product_facts` ("Details & fit"); every sentence's `claimIds` must resolve (§A2.3).

## A6. Alt text (fixed shape and mapping) — *superseded in part by D5*

```ts
type AltPlan = { mediaId: string; evidenceId?: string; current: string; proposed?: string; action: "keep" | "replace" };
```
- Only media that were **inspected** (have an `evidenceId`) can get a new alt; others are `keep` (no fabricated descriptions).
- Validation: each `alts[i].evidenceId` must map to exactly one inspected `mediaId`; no duplicates; `alt` 10–160 chars (warn outside 20–125).
- Studio renders in the gallery may get alt from the claim set (e.g. "Alex Denim Shorts in black, worn with an oversized tee") but are marked `generated: true` and never used as evidence.

## A7. Tags (non-destructive)

- **Default: additive only.** The engine may *add* controlled tags (`men`/`women`, category, colour, ≤ 2 style words) and never removes an existing tag.
- Tag cleanup is a **separate migration** (Part B, B6) after a dependency audit: theme (`grep -r "tags contains\|product.tags" theme/`), Shopify Flow, apps (filters, search, reviews), Meta/Google feed rules, WMS code (`grep -r "tags" lib/ app/`).

## A8. Pipeline (revised)

```
generateSeoV3(productId):
  snap  = loadProductSnapshot(id)                 // seo, descriptionHtml, tags, media{id,alt,url}, updatedAt
  snapHash = sha256(stable(snap))                  // stale-edit protection (§A10)
  facts = verifiedFacts(id)                        // product_facts rows (verified only)
  ev    = loadEvidenceImages(id)                   // originals only, evN ids
  target = pageTarget(id)                          // Part B: query map → pattern, primary/secondary phrases
  out1  = claude(SYSTEM, user(snap, facts, ev, target))
  draft = render(out1, facts, target)              // title/meta/body/alts recomputed from out1.attributes
  f1    = gate(draft, out1, facts, ev)             // blockers vs warnings
  if blockers: out2 = claude(fix(f1)); draft = render(out2,…)   // attributes, phrase, title RECOMPUTED from out2
               f2 = gate(...)
  return { revision: { draft, claims, observations, findings, snapHash, model, usage }, status: blockers ? "needs_review" : "ready" }
```

Fixes from review: phrase/title are always recomputed from the output actually used (rev 1 reused pre-rewrite attributes).

## A9. Data model (revised — *superseded in part by D4* — migration `0107_seo_engine.sql`)

```sql
CREATE TABLE IF NOT EXISTS product_facts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   text NOT NULL,                      -- Shopify gid
  field_class  text NOT NULL CHECK (field_class IN ('fit','material','care','measurement','origin','visual','set_composition')),
  field        text NOT NULL,                      -- e.g. 'composition', 'inseam', 'care'
  value        text NOT NULL,                      -- '98% cotton, 2% elastane' | '9 in (size 32)'
  source       text NOT NULL CHECK (source IN ('merchant_confirmed','size_grading','supplier','catalog')),
  verified_by  uuid,
  verified_at  timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz
);
CREATE INDEX IF NOT EXISTS product_facts_product_idx ON product_facts (product_id) WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS seo_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  kind text NOT NULL CHECK (kind IN ('pilot','wave','single')),
  scope jsonb NOT NULL, status text NOT NULL DEFAULT 'queued', job_id uuid,
  totals jsonb NOT NULL DEFAULT '{}'::jsonb, model text
);

CREATE TABLE IF NOT EXISTS seo_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES seo_runs(id) ON DELETE CASCADE,
  product_id text NOT NULL, product_title text NOT NULL,
  cohort text CHECK (cohort IN ('treatment','control')),        -- pilot design (Part B, B7)
  status text NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','ready','needs_review','approved','rejected','publishing','published','partial','conflict','reverted','failed','skipped')),
  snapshot jsonb, snapshot_hash text,                -- what the proposal was generated against
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, product_id)
);

-- Immutable revisions: generated, edited, approved — approval points at one revision by id + hash.
CREATE TABLE IF NOT EXISTS seo_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES seo_items(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('generated','edited')),
  payload jsonb NOT NULL,                            -- title, meta, bodyHtml, altPlan, tagsToAdd, claims, findings
  payload_hash text NOT NULL,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE seo_items ADD COLUMN IF NOT EXISTS approved_revision_id uuid REFERENCES seo_revisions(id);
ALTER TABLE seo_items ADD COLUMN IF NOT EXISTS approved_hash text;

-- Immutable backup + per-step publish log.
CREATE TABLE IF NOT EXISTS seo_publish_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES seo_items(id) ON DELETE CASCADE,
  step text NOT NULL CHECK (step IN ('backup','product','media','gmc_ai_attr','metafield','translate_mark','revert_product','revert_media','revert_gmc','revert_metafield')),
  idempotency_key text NOT NULL UNIQUE,              -- item_id:step:revision_hash
  state text NOT NULL CHECK (state IN ('pending','done','failed','skipped')),
  request jsonb, response jsonb, error text,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS seo_backups (
  item_id uuid PRIMARY KEY REFERENCES seo_items(id) ON DELETE CASCADE,
  taken_at timestamptz NOT NULL DEFAULT now(),
  live jsonb NOT NULL                                -- exact live values before the FIRST publish; never updated
);
```

## A10. Publish and revert — *superseded in part by D4* (explicit semantics)

**Approve** (server, `PATCH /api/shopify/seo/items/[id]`): stores `approved_revision_id` + `approved_hash`; re-runs `gate()` server-side; refuses if any blocker.

**Publish** (worker job `shopify_seo_publish`, per item):
1. Re-check: item `approved`, `approved_hash === sha256(revision.payload)`, server gate passes, user still admin.
2. **Stale check:** load live snapshot; if `sha256(stable(live)) !== item.snapshot_hash` → status `conflict`, show a 3-way diff (generated-from / live now / proposal) for re-review. No write.
3. `backup` step: insert `seo_backups` row only if none exists (immutable).
4. `product` step: `productUpdate { seo{title,description}, descriptionHtml (+ set banner via setNotice.ts) }` — tags via `tagsAdd` (additive). Idempotency key `item:product:hash`; a retried done step is skipped.
5. `media` step: `productUpdateMedia` for `altPlan.action === "replace"` only.
6. `gmc_ai_attr` step: supplemental data source upsert for every listing of the product (§A11).
7. `metafield` step: `carbon.seo_revision = <revision id>`, `carbon.seo_published_at`.
8. `translate_mark` step: nothing to call — Shopify marks es/pt-BR translations outdated when the source digest changes; record the item id in a "needs translate" list shown on the Translate panel.
9. Item → `published` only when steps 4–7 are `done`; any failed step → `partial` (retry button resumes from the failed step; done steps are skipped by key).

**Revert** (`POST /api/shopify/seo/items/[id]/revert`):
1. Load live; if live ≠ the published revision's values (someone edited after publish) → `conflict`, require explicit "revert anyway" per field.
2. Write `seo_backups.live` back for every field the publish changed (seo title/description, descriptionHtml, **remove only the tags the engine added**, alts it replaced), clear `carbon.seo_revision`, delete the supplemental GMC AI attributes it set.
3. Steps logged as `revert_*` with their own idempotency keys; item → `reverted`.
4. Translations: es/pt-BR become outdated again on the reverted text → listed for the Translate button (which re-translates from the restored English).

## A11. Merchant Center AI-content attributes — *superseded in part by D1*

Per Google's requirements for AI-generated feed text, for each published product, for every Merchant Center listing of it (all variants, `en` and `es` content languages):

```ts
await merchant.productInputs.insert({
  dataSource: "accounts/779385360/dataSources/10768074810",   // our existing supplemental source (also carries ad labels)
  productInput: {
    offerId, contentLanguage, feedLabel,
    productAttributes: {
      // keep existing customLabel0 values written by Sync ads — read-modify-write, never drop them
      ...existingSupplementalAttributes,
      structuredDescription: { digitalSourceType: "trained_algorithmic_media", content: plainDescription },
      structuredTitle: { digitalSourceType: "trained_algorithmic_media", content: shoppingTitle },   // only if the title was AI-written
    },
  },
});
```

Open verification items before bulk (blocking): (1) confirm the Merchant API field names/values against current docs on implementation day; (2) confirm a supplemental `structuredDescription` overrides/annotates the Shopify-app `description` as intended (test on 1 product, read back `products.get`); (3) the existing v1 AI descriptions (V2) need the same attribute now — a one-off backfill is proposed in B5 regardless of the rewrite; (4) the Sync ads job must merge, not replace, supplemental attributes (`setGmcLabels` currently writes only `customLabel{n}` → change to read-modify-write).

## A12. Quality gate (revised)

`Finding.level`: **blocker** (cannot publish) or **warning** (shown, publishable).

Blockers: banned brand rules ("Carbon Jeans" as brand, logo described by shape); unsupported non-visual claim (A2.3); claim id not resolvable; repeated name/category in title; inspected-image alt mapping errors; HTML outside the allowed tags; stale snapshot at publish.
Warnings: cliché list; title > 60 / meta > 155 or < 90; phrase absent; near-duplicate with a sibling (> 0.45 8-gram overlap); intro > 3 sentences.

Quote parsing (fixes apostrophe ambiguity): quotes are `"…"`, `“…”`, or `'…'` only when the opening `'` is preceded by start/space/punctuation and the closing `'` is followed by end/space/punctuation (`/(^|[\s(\[])'([^']{2,60})'(?=$|[\s.,;:!?)\]])/`); possessives (`men's`) never open a quote.

## A13. Draft-code fixes requested by the review

| Review item | Fix |
|---|---|
| Facts filter lets `BACK: woven label with 'CARBON JEANS' and logo.` through | Label/patch detection applies to **every** line, not only TEXT/LOGO/GRAPHIC: `if (/\b(label|patch|tag|woven)\b/i.test(line) && !isDesignNotLabel(line)) continue;` + golden test with that exact line. |
| `shirts?` matches `SWEATSHIRT` | Normalise first: `type = productType.split(">>").pop().trim().toLowerCase()`; rules use `^…$`/word boundaries and run specific→broad: `sweatshirt`, `t-?\s?shirt\|tee`, `tank`, `button shirt\|shirt\b`. Test every one of the 63 live product types (fixture from Admin API). Unknown/ambiguous subtype (shoes, swimwear for women) → `category: "other"` + **review flag**, no default noun. |
| Alt shape inconsistency / empty arrays pass | `AltPlan` (A6); validate count = inspected images, ids exact, no empty `alt`; `[]` is valid only when zero images were inspected. |
| Stale attributes after rewrite | A8 — everything downstream recomputed from the output used. |
| Stale proposals overwrite newer edits | `snapshot_hash` + conflict state (A10.2). |
| Partial writes | Step log with idempotency keys; `partial` status; resumable (A10). |
| Destructive tag cleanup | Additive only; cleanup is a separate audited migration (A7, B6). |
| Approval not tied to final revision | Immutable `seo_revisions`; approval stores id + hash; publish re-verifies (A9, A10.1). |
| Siblings by title stem | Use WMS matrix family first: products sharing `matrices.set_group_id` or the same matrix-name stem in `matrices.description`; title stem only as fallback. True variants may share factual details; the near-duplicate check is a warning, never a reason to invent differences. |

## A14. Tests

`scripts/test-seo-engine.ts` (`npx tsx --test`), fixtures captured from live data (read-only scripts):
- `fixtures/product-types.json` — all 63 live types → expected category/gender (incl. `MEN >> SWEATSHIRTS`, `SHORTS`, `DRESS`, `WOMEN`, `GENERAL`).
- `fixtures/studio-specs/*.txt` — the black shorts spec (both old "woven label" and new "leather patch" wording), Camilo, a tee with a back print.
- Title builder: no repeated words; brand suffix; patterns P1–P3.
- Claims: "100% cotton" with no fact → blocker; with `merchant_confirmed` fact → ok.
- Alt mapping: count mismatch, duplicate id, empty array cases.
- Publish state machine: simulated failure after `product` step → `partial`; retry skips `product`, runs `media`.
- Revert: live edited after publish → `conflict`.

`scripts/eval-seo-engine.ts --limit 12` — no writes; outputs proposals + findings + cost for owner review of voice and accuracy.

---

# PART B — Business SEO Plan (the engine is one component)

## B1. Data access (prerequisite)
- **Search Console:** owner adds `claude-merchant-reader@shopify-ai-catalog.iam.gserviceaccount.com` as a *Restricted* user on the `shopcarbon.com` property (Settings → Users and permissions → Add user); enable "Google Search Console API" in GCP project `shopify-ai-catalog`. No phone login needed.
- **GA4 / Shopify analytics:** organic sessions, add-to-cart, purchases, revenue per landing page (Shopify `run-analytics-query` / ShopifyQL `FROM sessions` and `FROM sales` by landing page where available).
- **Google Ads Keyword Planner** (available now, V4): `KeywordPlanIdeaService.GenerateKeywordHistoricalMetrics` for candidate phrases, US, English (+ Spanish).

## B2. Query → page map — *superseded in part by D6*
1. Pull 16 months of Search Console query × page data; split **branded** (`carbon`, `shopcarbon`, product names) vs **nonbranded**.
2. Cluster nonbranded queries by intent: *broad category* ("men's ripped jeans", "matching sets for women"), *specific item* ("black ripped denim shorts men"), *local* ("clothing store edgewater orlando").
3. Add demand (Keyword Planner volume, competition) and business value (stock depth, margin, sales — WMS + Shopify).
4. Assign each cluster to one page: broad → collection, specific → product, local → store page. Store in `page_targets (page, primary_query, secondary_queries[], intent, title_pattern, priority)`.
5. The engine (Part A) reads `page_targets` for product titles/meta; collections get their own content (B3).
Starting hypotheses to test (from navigation, not measured): men's skinny/baggy/ripped jeans, graphic tees, women's matching sets, dresses, denim shorts.

## B3. Collection SEO
For priority collections from B2: H1, SEO title/meta, a short buying-guide intro (2–4 sentences, above or below the grid per theme), crawlable links to subcollections and top products, and links from products back to their main collection (breadcrumb already in JSON-LD; verify in theme). Same review/backup/revert workflow (collections are a second resource type in `seo_items`).

## B4. Technical SEO audit — *superseded in part by D7* (checks to run, results unknown)
- Indexing & coverage (Search Console), canonical on product/variant/collection URLs, filter/sort parameter handling, pagination, sitemaps (present: products/pages/collections/blogs/articles + `sitemap_agentic_discovery.xml`).
- Structured data: validate `ProductGroup`/variants, price, availability for a sample with Rich Results Test and Merchant Center diagnostics.
- Core Web Vitals / mobile on PDP and collection templates.
- Sold-out / archived product behaviour (archived → 404 vs redirect to collection).
- Internal linking from home/nav to priority collections.
- Spanish/Portuguese: `/es` and `/pt` URLs return 200, self-canonical per language, `hreflang` set covers en/es/pt-BR/x-default on PDP and collections (rev 1 saw 4 `hreflang` tags — verify values). Localised titles/meta come from the Translate job; **localised keyword targeting** (Spanish queries in B2) is added to the Translate prompt as per-page target phrases.

## B5. Merchant Center
- Shopping titles = SEO titles (V1): the doubled-title fix (A4) improves Shopping immediately; keep titles short enough that the variant suffix fits.
- AI-content attributes (A11) for every published AI description; **one-off backfill now** for existing v1 AI descriptions (separate, small job; independent of the rewrite).
- Re-check GMC diagnostics after each wave.

## B6. Tag audit and cleanup (separate project)
Dependency audit (theme, apps, Flow, feeds, WMS) → proposal list (keep / merge / delete) → owner approval → migration with backup → monitor.

## B7. Measured pilot — *superseded in part by D6*
- **Select:** from B2, 80 products with meaningful organic impressions, across categories; split into matched pairs (category, impressions, stock, price band) → 40 **treatment**, 40 **control** (unchanged). Exclude products in active promotions or about to sell out.
- **Publish** treatment only; record publish time per product (`seo_items.cohort`, step log).
- **Measure** (treatment vs control, same windows, 28 days before vs 28–56 days after recrawl): nonbranded clicks & impressions & query coverage (Search Console), organic landing sessions, add-to-cart, purchases, revenue (Shopify/GA4), Shopping clicks for the same products (Google Ads `shopping_performance_view`). Note stock-outs, promos, seasonality per pair.
- **Decide** after the 8-week checkpoint (not a guarantee of significance): roll out in waves if treatment ≥ control on nonbranded clicks and conversions, adjust the voice/format otherwise. Already-strong pages (top 10 % by organic revenue) are excluded from the first wave.

## B8. Local discovery (Orlando showroom — 6250 Edgewater Dr Ste 100)
Google Business Profile completeness (categories, hours, photos, products), consistent NAP on site/store-locator/socials, a store landing page with LocalBusiness/ClothingStore schema, review acquisition (post-purchase and in-store QR). Ties into the existing Edgewater store-visit campaign.

---

# PART C — Response to the review, point by point

| Review point | Response | Where |
|---|---|---|
| 1. Research searches before choosing keywords; map broad→collections, specific→products; collections excluded | Accepted. Query→page map from Search Console + Keyword Planner + business data; collection SEO added. Needs Search Console access (B1). | B1–B3, A4 |
| 2. Photos can't verify material/stretch/care; legacy copy may carry AI errors; self-verification isn't verification | Accepted. Field-class evidence policy, `product_facts` with sources, legacy copy never a source, claim ids + blockers, Studio renders excluded as evidence. | A2, A5, A12 |
| 3. Keep useful measurements/composition; don't force one format | Accepted. Flexible format, optional styling, verified "Details & fit" with measurements; length targets advisory. | A3 |
| 4. Cleaner titles; targets as editorial | Accepted. `Men's Black Ripped Denim Shorts – Alex | Carbon`; pattern chosen by query data; 60/155 are warnings. | A4 |
| 5. Verify Merchant Center integration; AI attributes | Verified: Shopping titles **are** the SEO title (V1); Shopping descriptions **are the SEO meta** and carry no AI flag (V2, corrected in rev 3). AI attributes via supplemental source + backfill for v1 copy. | V1–V2, A11, B5 |
| 6. Measured pilot with controls; measure revenue not just CTR | Accepted. 40/40 matched pilot, nonbranded clicks + conversions + revenue, seasonality noted. | B7 |
| Technical SEO, ES/PT localisation, Orlando local | Added as audits/workstreams with explicit "unknown until checked". | B4, B8 |
| Draft-code issues 1–8 + quotes + siblings | All fixed in the spec with tests. | A6–A14 |

## Decisions needed from the owner — *rev 3 list in D9*
1. Grant Search Console access (B1) — needed before keyword decisions.
2. Approve the evidence policy: no material/care/fit claims until confirmed (you or supplier). Do you have supplier spec sheets (composition, care) to import?
3. Approve the pilot design (40 treatment / 40 control) instead of a storewide rewrite.
4. Approve the separate one-off **Merchant Center AI-attribute backfill** for today's descriptions (small, independent).
5. Title pattern default P1 (`Men's Black Ripped Denim Shorts – Alex | Carbon`) unless data says the name leads.

## Build order (after approval) — *replaced by D8*
1. B1 access + B5 backfill (small, independent).
2. A13 fixes + A2 evidence + A9 data model + A10 publish/revert + tests.
3. B2 query map (needs Search Console) → A4 titles from data.
4. 12-product eval (voice/accuracy) → owner approval.
5. B7 pilot (treatment only) → 8-week checkpoint → waves.
6. B3 collections, B4 technical audit, B6 tag audit, B8 local — scheduled by measured opportunity.

---

# PART D — Revision 3: answers to the rev-2 review (`CARBON-SEO-REV2-REVIEW.md`)

Part D replaces the sections marked *superseded*. Nothing is built. Production backfill and bulk publish stay blocked until the D1 proof and the D4 tests pass.

## D0. Evidence for the live findings (reviewable)

Everything below can be re-run. Scripts and their raw outputs are in `docs/seo/evidence/`.

| File | What it shows | How it was produced |
|---|---|---|
| `feed-mapping.py` → `feed-mapping.out.json` | Title and description mapping, languages, GTIN, brand | Merchant API v1 `accounts/779385360/products` (all 7,320 processed products, dumped 2026-10-11 09:23 ET), compared with Shopify Admin GraphQL `product { seo { title description } }` plus the short-description metafield, taken the same day. The comparison is a prefix match: 40 chars for the title, 55 for the description. |
| `barcodes.out.json` | Shopify variant barcodes | Admin GraphQL `variants { barcode }`, all 571 products |
| `site-audit.py` → `site-audit.out.txt` | Status, canonical, robots, hreflang, JSON-LD | Plain HTTP GET of 11 public URLs, 2026-10-11 |

Results:

| # | Finding | Number |
|---|---|---|
| E1 | English Shopping title starts with the Shopify SEO title (+ ` COLOUR / SIZE`) | **566 / 567** products |
| E2 | Shopping description starts with the Shopify **SEO meta description** | **561 / 567** (body/short description: 2 / 567) |
| E3 | Listings by language / feed label / data source | `en/US/10723206162` = 3,660; `es/US/10721703504` = 3,660. **There is no Portuguese feed.** |
| E4 | Spanish listings use the Spanish SEO title and meta, and the variant options are translated too: `Chaqueta Bradley - Chaqueta Bradley AZUL OSCURO / XL` | Spanish Shopping text therefore comes from the **Translate job's** output |
| E5 | Organic colour words contradict the variant: `Keep On Moving Shirt - Stylish Black Graphic Tee WHITE / L` | Example. This is why Shopping needs its own variant-built title (D2) |
| E6 | GTIN on listings: **0 / 7,320**. `identifierExists=false`: 3,638; unset: 22. `mpn`: 0. `brand` = `CARBON` on all | |
| E7 | Shopify barcodes: 1,594 values, **all 7 digits**. In 516 / 516 multi-variant products, every variant shares **one** barcode (e.g. `1223303`) | These are internal style codes, **not GTINs**. `identifierExists=false` is correct. They must never be sent as `gtin`. |
| E8 | `structuredTitle` / `structuredDescription` present | 0 / 7,320 |
| E9 | PDP `<title>` doubled in all three languages: `Alex Denim Shorts - Alex Denim Shorts`, `Shorts de mezclilla Alex - Shorts de mezclilla Alex`, `Shorts Jeans Alex - Shorts Jeans Alex` | site audit |
| E10 | Canonical is self/clean on PDP, variant URLs and collections. `?sort_by=` is `noindex, follow`. `?page=2` is self-canonical. hreflang = x-default, en, es, pt | site audit |
| E11 | PDP JSON-LD `ProductGroup`: every variant has price + availability + sku, gtin = 0 (consistent with E7). Collections carry Breadcrumb + Organization only | site audit |
| E12 | Archived product URL (`/products/startdust-denim-jacket`) returns **404**, with no redirect | site audit |
| E13 | Store locator: `<title>RETAIL STORE LOCATOR</title>` (all caps), schema `Place`, not `ClothingStore` / `LocalBusiness` | site audit |

What this evidence does **not** prove, as the review asks:

- E1/E2 are a field-equality observation, not the app's configuration screen.
- D1 step 0 adds a **controlled test**: change one product's SEO title and meta to a marker string, wait for the Shopify app sync, then read the listing back.
- The Shopify Google & YouTube app has no title/description source setting that we have found. If one exists, D1 step 0 records it.

## D1. Merchant Center: precedence, enum, single writer

### D1.1 The problem, restated

- Google: when both `title` and `structuredTitle` are present, **`title` wins**. The same holds for `description` and `structuredDescription`.
- The Shopify primary source always sends the ordinary fields (E1/E2).
- So a supplemental `structuredTitle` alone is expected to **lose**. Rev 2's plan would have annotated text that never shows.

### D1.2 One-product proof (blocking for any GMC write beyond labels)

Run on one low-traffic product with ≥ 2 variants. Every step is read back with `products.get` on the processed product **and** on each `productInputs`.

| Step | Config | Pass condition |
|---|---|---|
| 0 | Change the Shopify SEO title/meta to marker strings `ZZTEST-T` / `ZZTEST-D` | Within one sync, the listing title starts with `ZZTEST-T` and the description equals `ZZTEST-D` (proves the E1/E2 mapping causally). Restore afterwards. |
| 1 | Supplemental input: `structuredTitle` + `structuredDescription` only | Record which text is effective. Expected: the Shopify text wins. |
| 2 | Supplemental input: ordinary `title` + `description` (our Shopping text) **and** `structuredTitle` + `structuredDescription` with the same content and `digitalSourceType: TRAINED_ALGORITHMIC_MEDIA` | Effective title/description = our text, **and** the structured attributes are retained on the processed product with no new item issue |
| 3 | If step 2 fails: Merchant Center **data-source attribute rule** on the primary source that leaves `title` / `description` empty when a supplemental `structuredTitle` exists | Same pass condition as step 2 |
| 4 | Whichever step passed: edit the product in Shopify (price change) → wait for the app re-sync | Our text is still effective, and the structured attributes are still present |
| 5 | +24 h, then +72 h | Same as 4. No `attribute_pending_review` stuck state. Ad labels (`customLabel0`) are unchanged. |
| 6 | Spanish listing of the same offer (`es/US`) | Our Spanish artifact is effective there, and English never appears in the `es` input |

- **Decision rule.** Use the first configuration that passes 2→6.
- **If none passes:** keep the Shopify-supplied text. Do not write title/description overrides. Report back to the owner and to Codex before anything else. We will **not** ship an ordinary-field override without the AI annotation as a silent fallback.
- **Proof log:** `docs/seo/evidence/gmc-precedence-proof.md`, with the raw API responses for each step.

### D1.3 API representation

The REST JSON uses the enum `TRAINED_ALGORITHMIC_MEDIA`. The lowercase `trained_algorithmic_media` is the feed-file token only and is never used in API calls. Shape, per Merchant API v1 `ProductAttributes`:

```ts
// lib/server/google-merchant.ts (new types)
type StructuredText = { digitalSourceType: "TRAINED_ALGORITHMIC_MEDIA" | "DEFAULT"; content: string };
export type OwnedFeedFields = {
  title?: string;                       // only if D1.2 step 2 is the passing config
  description?: string;
  structuredTitle?: StructuredText;
  structuredDescription?: StructuredText;
  customLabel0?: string; customLabel1?: string; customLabel2?: string; customLabel3?: string; customLabel4?: string;
};
```

A unit test pins the serialised JSON against a fixture copied from the docs on implementation day.

### D1.4 Single writer for the supplemental source

`productInputs.insert` **replaces** the whole input for (offerId, contentLanguage, feedLabel). So there is **one writer module** and **one local source of truth** for what we own. We never copy a processed (merged) product back into an input.

```sql
-- migration 0107 (part)
CREATE TABLE IF NOT EXISTS gmc_supplemental_state (
  offer_id         text NOT NULL,
  content_language text NOT NULL,
  feed_label       text NOT NULL,
  fields           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- OwnedFeedFields: the COMPLETE input we last sent
  field_owner      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"customLabel0":"ads_sync","structuredDescription":"seo",...}
  version          bigint NOT NULL DEFAULT 0,
  last_sent_at     timestamptz,
  last_response    jsonb,
  PRIMARY KEY (offer_id, content_language, feed_label)
);
CREATE TABLE IF NOT EXISTS gmc_supplemental_history (      -- every change, for revert
  id bigserial PRIMARY KEY,
  offer_id text NOT NULL, content_language text NOT NULL, feed_label text NOT NULL,
  version bigint NOT NULL, before jsonb NOT NULL, after jsonb NOT NULL,
  writer text NOT NULL, ref text,                          -- 'seo:<op id>' | 'ads_sync:<job id>' | 'backfill:<job id>'
  created_at timestamptz NOT NULL DEFAULT now()
);
```

```ts
// lib/server/gmc-supplemental-writer.ts  — the ONLY code that calls productInputs insert/delete on DS 10768074810
export async function writeOwnedFields(
  key: { offerId: string; contentLanguage: string; feedLabel: string },
  writer: "seo" | "ads_sync" | "backfill",
  patch: Partial<OwnedFeedFields> & { [k: string]: unknown | null },   // null = remove that field
  ref: string,
): Promise<{ version: number; before: OwnedFeedFields; after: OwnedFeedFields }> {
  return withTx(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`gmc:${key.offerId}:${key.contentLanguage}:${key.feedLabel}`]);
    const cur = await db.one("SELECT fields, field_owner, version FROM gmc_supplemental_state WHERE ... FOR UPDATE")  // or defaults
    for (const k of Object.keys(patch)) {
      const owner = cur.field_owner[k];
      if (owner && owner !== writer) throw new Error(`field ${k} is owned by ${owner}`);  // labels ↔ ads_sync, text ↔ seo/backfill
    }
    const after = applyPatch(cur.fields, patch);              // drop nulls
    if (stableEqual(after, cur.fields)) return { version: cur.version, before: cur.fields, after };
    if (isEmpty(after)) await merchant.productInputs.delete(key, DS_SUPPLEMENTAL);
    else await merchant.productInputs.insert(DS_SUPPLEMENTAL, { ...key, productAttributes: after });   // COMPLETE input from local state
    await db.query("UPDATE/INSERT gmc_supplemental_state SET fields=$after, field_owner=..., version=version+1 ...");
    await db.query("INSERT INTO gmc_supplemental_history (...) VALUES (...)", [/* before=cur.fields, after */]);
    return { version: cur.version + 1, before: cur.fields, after };
  });
}
```

- The API call happens **inside** the advisory lock. Two workers can never interleave on one offer.
- If the API succeeds but the DB commit fails, the next write sends the complete input again, so the result converges.
- `backfill` and `seo` both own text fields. A backfill value is replaced by `seo` through an explicit `writer:"seo"` takeover that is recorded in history.
- **Sync ads change:**
  - `setGmcLabels` / `clearGmcLabels` in `lib/server/google-merchant.ts` are rewritten to call `writeOwnedFields(…, "ads_sync", {customLabelN: value|null})`.
  - First-run import: today's labels are read from the supplemental `productInputs` (not processed products) into `gmc_supplemental_state`.
- `productInputs.patch` with an `updateMask` is the alternative. We use the local-state insert because it gives an exact before/after for revert. We will switch to patch only if the D1 proof shows insert loses fields the Shopify app needs.

## D2. Separate organic and Shopping outputs, per language

### D2.1 Artifacts

A revision now has **two output families**:

| Artifact | Where it goes | Built from |
|---|---|---|
| `organic.title` (~45–60 chars), `organic.meta` | Shopify `seo.title` / `seo.description` | A4 patterns (P1–P3) |
| `organic.bodyHtml` | Shopify `descriptionHtml` (+ set banner via `setNotice.ts`) | A3 |
| `shopping[variantId].title` (≤ 150) | GMC `title`/`structuredTitle` per offer | **Deterministic** from verified attributes + **that variant's** options |
| `shopping.description` (≤ 5,000, plain text) | GMC `description`/`structuredDescription` | intro + key details + verified facts; **no** set banner, cross-sell, outfit line or promotion |

```ts
// lib/seo/shopping-title.ts
export function shoppingTitle(a: { brand: "Carbon"; name: string; gender?: "Men's" | "Women's"; style: string[]; noun: string;
                                   variant: { colour?: string; size?: string; sizeKind: "waist" | "alpha" | "numeric" | "one" } }): string {
  const nameShort = stripNoun(a.name, a.noun);                 // "Alex Denim Shorts" → "Alex"
  const head = [a.brand, nameShort, a.gender, ...a.style.map(cap), capNoun(a.noun)].filter(Boolean).join(" ");
  const tail = [titleCase(a.variant.colour), sizeLabel(a.variant)].filter(Boolean).join(", ");   // "Black, Waist 32"
  return dedupeWords(tail ? `${head}, ${tail}` : head).slice(0, 150);
}
// shoppingTitle({brand:"Carbon",name:"Alex Denim Shorts",gender:"Men's",style:["ripped"],noun:"denim shorts",
//                variant:{colour:"BLACK",size:"32",sizeKind:"waist"}}) → "Carbon Alex Men's Ripped Denim Shorts, Black, Waist 32"
```

- The **variant's own colour option** is used, never the organic colour word. This fixes E5.
- A product-level colour adjective in `style` is dropped when the variant colour differs.
- Brand appears once, as the manufacturer at the front. There is no ` | Carbon` store suffix in Shopping.

### D2.2 Languages

- Feed languages are **enumerated from Merchant Center**, never assumed. Today that is `en/US` and `es/US` (E3).
- Artifacts are stored per language in `seo_feed_artifacts`. The English draft never goes into an `es` input.

```sql
CREATE TABLE IF NOT EXISTS seo_feed_artifacts (
  product_id text NOT NULL, variant_id text NOT NULL, language text NOT NULL,      -- 'en' | 'es' | …
  revision_id uuid NOT NULL REFERENCES seo_revisions(id),
  title text NOT NULL, description text NOT NULL,
  source_hash text NOT NULL,     -- sha256(revision payload + facts version + variant options + translation digest)
  built_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, variant_id, language)
);
```

- **English:** built from the approved revision.
- **Spanish:**
  - The Translate job (`lib/server/shopify-translate.ts`) gains a `feed` target. It translates `shopping.description` and the Shopping-title **head** once per product, with the same glossary and judge.
  - The per-variant tail uses the Shopify-translated option values, which already exist (E4).
  - Until the Spanish artifact exists, the `es` listing is **not overridden** and keeps Shopify's Spanish text. It is flagged "Spanish feed text pending".

### D2.3 Keeping the feed in sync — `seo_feed_sync` (worker job, nightly + on demand)

Triggers mark a product **dirty** in `seo_feed_dirty(product_id, reason, at)`:

- an approved revision is published or reverted;
- a Translate run changes a product (es);
- `product_facts` change;
- Sync ads finds new, renamed or removed variants;
- Shopify `products/update` webhook with an options or variants change.

```
for product in dirty ∪ (weekly full sweep):
  listings = merchant.products.list filtered to offers of product (all languages / feed labels actually present)
  for listing:
    art = seo_feed_artifacts[product, variant, listing.contentLanguage]
    if !art or art.source_hash stale → rebuild art (en) or queue translate (es); skip override for now
    desired = { [title|structuredTitle], [description|structuredDescription] } per the D1 passing config
    writeOwnedFields(listing key, "seo", desired, ref)            // no-op when equal
  listings that disappeared → writeOwnedFields(key, "seo", {all seo fields: null})
```

## D3. Claims constrain the actual words and values

### D3.1 Schema changes (replaces A2.3 and the claim parts of A5)

```ts
const FieldClass = z.enum(["visual","fit","material","performance","care","measurement","origin","set_composition"]);
const Claim = z.object({
  id: z.string().regex(/^c\d+$/),
  fieldClass: FieldClass,
  field: z.string(),                    // 'colour' | 'graphic' | 'patch' | 'composition' | 'stretch' | 'inseam' | 'included_pieces' …
  value: z.string().max(120),           // the normalised value the sentence may express, e.g. 'black', '98% cotton, 2% elastane'
  source: z.string(),                   // 'ev2' (visual only) | 'fact:<uuid>'
  variantScope: z.array(z.string()).nullable(),   // null = all variants
});
const Sentence = z.object({ text: z.string().min(3), claimIds: z.array(z.string()).min(1) });   // EMPTY claimIds now rejected
const Out = z.object({
  observations: z.array(z.object({ evidenceId: z.string(), fact: z.string() })).min(3).max(25),
  claims: z.array(Claim).min(2).max(25),
  attributes: z.object({ colour: Attr, style: z.array(Attr).max(2), noun: Attr }),   // Attr = { value, claimIds: min(1) }
  intro: z.array(Sentence).min(1).max(3),
  styling: Sentence.nullable(),
  details: z.array(Sentence).max(5),
  meta: z.array(Sentence).min(1).max(2),            // meta is claim-linked too
  shoppingDescriptionExtra: z.array(Sentence).max(3),
});
```

- Titles are not free text. They are rendered from `attributes`, whose values carry claim ids.
- Alt text has its own path (D5), with claims linked the same way.

### D3.2 Deterministic validator (the authority; a model check is advisory only)

`validateCopy(out, facts, evidence, product)` runs over **every** text field: organic title, meta, body sentences, the Shopping title head, the Shopping description and alt texts.

1. **Claim resolution.**
   - A `fact:` claim's fact must exist, belong to this product, and be unsuperseded and verified.
   - Its `field_class` and `field` must equal the claim's.
   - Its normalised `value` must **equal** the claim's value (case and whitespace folded, `%` spacing normalised).
   - Its `variant_scope` must cover the claim's scope.
   - A `visual` claim must cite an `evN` that exists in *this* run's evidence set.
   - Visual is only allowed for `field ∈ VISUAL_FIELDS` (colour, graphic, text_print, distressing, pockets_visible, closure_visible, neckline, sleeve, hem, silhouette_look, patch_presence, hardware_colour).
2. **Assertion extraction.** A lexicon pass over each sentence finds every non-visual assertion term. Every term found must be **covered by a claim that the sentence cites**: the claim has a matching class and its value contains the term (or a lexicon synonym).

```ts
// lib/seo/assertion-lexicon.ts
export const LEXICON: Record<"material"|"performance"|"care"|"fit"|"measurement"|"origin"|"set_composition", RegExp[]> = {
  material: [/\b\d{1,3}(?:[.,]\d+)?\s?%/g,                                   // fixes rev 2: no \b after %
             /\b(cotton|polyester|elastane|spandex|lycra|linen|wool|cashmere|silk|satin|viscose|rayon|modal|nylon|acrylic|
                leather|suede|faux|vegan|pu|recycled|organic|bamboo|hemp|fleece|jersey|twill|chiffon|velvet|corduroy|knit(?:ted)?)\b/gi],
  performance: [/\b(stretch(?:y)?|soft|breathable|lightweight|heavyweight|durable|moisture[- ]wicking|warm|water[- ]?(?:proof|resistant)|wrinkle[- ]free|non[- ]?sheer)\b/gi],
  care: [/\b(machine[- ]wash(?:able)?|hand[- ]wash|dry[- ]clean|tumble[- ]dry|iron)\b/gi],
  fit: [/\b(true to size|runs (?:small|large|big)|size (?:up|down)|slim[- ]fit|regular[- ]fit|relaxed[- ]fit|oversized fit|skinny fit|high[- ]rise|mid[- ]rise|low[- ]rise)\b/gi],
  measurement: [/\b\d+(?:[.,]\d+)?\s?(?:in(?:ch(?:es)?)?|"|cm|mm)\b/gi, /\b(inseam|rise|length)\s+(?:of\s+)?\d/gi],
  origin: [/\bmade in\b/gi, /\b(imported|handmade|hand[- ]made)\b/gi],
  set_composition: [/\b(includes?|comes with|sold (?:together|separately)|two[- ]piece|2[- ]piece|set of)\b/gi],
};
```

- Fit wording phrased as appearance ("a relaxed, straight look") is allowed with a `visual` `silhouette_look` claim. The phrase `/\b(looks?|look)\b/` must sit within 3 words of the fit term, or the term is treated as a fit assertion.
- A sentence citing claim `c3` (`material: 98% cotton`) that also says "breathable" fails. "breathable" is `performance` and no cited claim covers it. This is the review's "cotton must not authorise breathable/stretch" case.
- `leather`, `suede`, `faux` and `vegan` are **material** terms everywhere. **The rev-2 "leather patch" exception is removed.**
  - Without a verified `trim_material` fact, copy says "a brown patch at the back waistband".
  - Studio's image spec may still say "leather patch". That text is a render instruction, never SEO evidence.
3. **Non-visual details are rendered, not written.** The "Details & fit" block, material, care, measurements and origin come from a template over `product_facts`. Prose may mention them only with a cited fact claim, and rule 2 checks it.
4. **Brand and logo rules (unchanged):**
   - "Carbon Jeans" may appear only as quoted label text, never as the brand.
   - The logo is "the Carbon logo", never "hexagon logo".
   - Any **label or patch text is not described in SEO copy at all** unless the owner marks it as a selling point. This answers the owner's "why is a denim label mentioned at all?"
5. **Secondary model check.** A short Claude pass lists sentences that seem unsupported. Its findings are **warnings** shown to the reviewer and never clear a blocker.

Golden tests (added to A14):

| Input | Expected |
|---|---|
| `Made with 100% recycled fibers.` + no fact | blocker (`%` and `recycled`) — the review's case |
| `Made with 100% recycled fibers.` citing fact `composition = 100% cotton` | blocker (value mismatch: recycled not in value) |
| `Soft 98% cotton.` citing fact `98% cotton` | blocker (`soft` = performance, uncovered) |
| `98% cotton, 2% elastane.` citing exact fact | pass |
| `A leather patch at the back.` citing `ev2 patch_presence` | blocker (`leather`) |
| `A brown patch at the back.` citing `ev2 patch_presence` | pass |
| Sentence with `claimIds: []` | schema reject |
| Meta with an unsupported "true to size" | blocker |

### D3.3 Sets

- `matrices.is_set` and the `carbon_set.partners` metafield show that pieces are **linked**. They do not show what one purchase contains.
- New fact fields, `merchant_confirmed` only:
  - `included_pieces` (e.g. "top and shorts", meaning the purchase includes both);
  - `sold_separately_match` (handles of matching pieces sold on their own pages).
- WMS data **proposes** values in the facts UI ("This matrix is marked Set with partner `river-bottom-set` — included together, or sold separately?"). Nothing is asserted until the owner answers.
- Copy validation:
  - "includes / comes with / two-piece" needs an `included_pieces` claim.
  - "pair it with the matching …" needs `sold_separately_match`.
  - `set_composition` with no confirmed fact → the set sentence is omitted and the reviewer sees "set contents unconfirmed".

## D4. Publish, resume and revert: one operation ledger

### D4.1 Plan at approval

On approval, the server builds an **operation plan** from the approved revision and the live state read at that moment. Each operation is one external value.

```ts
type Op = {
  opId: string;                                   // `${itemId}:${target}:${revisionHash}` — also the idempotency key
  target:                                         // exactly one external value
    | "shopify.seo.title" | "shopify.seo.description" | "shopify.descriptionHtml"
    | `shopify.media.alt:${string}`               // per Shopify media id
    | "shopify.tags.add"                          // the set of tags this op introduces
    | `shopify.metafield:${string}`               // 'carbon.seo_revision' | 'carbon.seo_published_at'
    | `gmc:${string}`;                            // `${offerId}|${lang}|${feedLabel}` — the seo-owned fields
  before: unknown;                                // exact live value at plan time (absent → { absent: true }, metafield incl. type)
  after: unknown;                                 // value the op will write
  dependsOn?: string[];
};
```

```sql
-- replaces seo_publish_steps / seo_backups from A9
CREATE TABLE IF NOT EXISTS seo_ops (
  op_id        text PRIMARY KEY,
  item_id      uuid NOT NULL REFERENCES seo_items(id) ON DELETE CASCADE,
  direction    text NOT NULL CHECK (direction IN ('publish','revert')),
  target       text NOT NULL,
  before       jsonb NOT NULL,
  after        jsonb NOT NULL,
  state        text NOT NULL CHECK (state IN ('planned','sent','done','adopted','conflict','failed','skipped')),
  attempts     int NOT NULL DEFAULT 0,
  request      jsonb, response jsonb, error text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS seo_items_one_active_per_resource
  ON seo_items (resource_type, resource_id) WHERE status IN ('publishing','reverting');
```

- Several ops are merged into one API call where the API allows it (e.g. one `productUpdate` for title + meta + body). Each op still keeps its own row and its own read-back.
- Tags are **always a separate op** (`tagsAdd`). If `productUpdate` succeeds and `tagsAdd` fails, only the tag op is retried.

### D4.2 One executor for first publish and resume

```
executeItem(item, direction):
  acquire pg_advisory_lock(hashtext('seo:' || resource_type || ':' || resource_id))     // session lock, held for the whole item
     ↳ Translate and Sync ads take the same lock before writing that product (short hold)
  require item.status ∈ (direction==publish ? {approved, partial} : {published, partial_revert})
  require approved_hash == sha256(revision.payload) and server gate passes and actor still admin
  set status publishing|reverting
  for op in topo(ops where state ∉ {done, adopted, skipped}):
    live = read(op.target)
    if equal(live, op.after):  op.state = 'adopted'        // our earlier write landed (incl. crash after Shopify accepted, before we logged)
    elif equal(live, op.before):
       op.state='sent'; write(op); live2 = read(op.target)
       op.state = equal(live2, op.after) ? 'done' : 'failed'
    else: op.state = 'conflict'                            // outside edit since the plan — never overwrite
  status = all ops ∈ {done, adopted, skipped} ? (publish ? 'published' : 'reverted')
         : any conflict ? 'conflict' : 'partial'
  release lock
```

- **Resume** is the same executor, called on a `partial` item. No item-level snapshot hash is compared, so the engine's own completed writes never block it. Each op is checked against its own `before`/`after`.
- **Crash after Shopify accepts:** the op stays `sent`. On the next run, `live == after` → `adopted`.
- **Conflict:** the reviewer sees a per-op diff: plan-time value / live now / ours. They choose per op: *skip*, *re-plan from live* (a new `before`; requires re-approval), or *overwrite* (explicit, logged).
- **Concurrency:**
  - The advisory lock serialises workers and runs.
  - The unique partial index stops two active publishes of one resource.
  - GMC ops additionally go through `writeOwnedFields` (D1.4), which has its own per-offer lock.

### D4.3 Revert restores, never just clears

- Revert builds a new plan with `direction='revert'`. For each completed publish op it creates a revert op with `before = publish.after` and `after = publish.before`.
- **Metafields:**
  - If the metafield existed before, its exact prior value and type are restored.
  - Only if it was absent before is it deleted.
- **Tags:** the revert op removes **only** the tags that op introduced (`after \ before`), and only those still present. Tags anyone added later are untouched.
- **Media alt:** the prior alt is restored per media id.
- **GMC:**
  - The revert target is the `gmc_supplemental_history.before` row of the publish op's version.
  - This restores the earlier owned state, including a **backfill**-written `structuredDescription` and its `TRAINED_ALGORITHMIC_MEDIA` flag for the old v1 AI text.
  - The fields are not deleted. This is exactly the review's case.
  - Labels are untouched, because they are owned by `ads_sync`.
- Later unrelated changes survive. The revert executor uses the same rule: write only where `live == publish.after`. Anything else becomes a per-field conflict.
- **Translations:** reverting English makes es/pt-BR outdated. The product is listed for Translate, and the D2.3 feed sync marks it dirty.

### D4.4 Tests (replace A14's publish bullets)

- Fail the media op after the product op → `partial`. Resume: product op `adopted`, media op `done`, then `published`.
- Kill the worker after the Shopify `productUpdate` returns but before the DB update → resume adopts.
- Outside edit of `seo.title` between approval and publish → only that op `conflict`; other ops are still done; status `conflict`.
- Two workers start the same item → the second fails to acquire the lock (`pg_try_advisory_lock`) and exits without writing.
- Revert after the backfill → the GMC structured description equals the backfill value with `TRAINED_ALGORITHMIC_MEDIA`, not empty.
- Revert with a tag added by staff after publish → that tag stays.
- `tagsAdd` fails after `productUpdate` → only the tag op is retried.

## D5. Evidence photos vs gallery media

Two separate id spaces:

```ts
type EvidencePhoto = {           // proves facts about the real garment
  evidenceId: `ev${number}`;
  provenance: "studio_ref_original" | "shopify_media_original" | "merchant_upload";
  sourceRef: string;             // R2 key or Shopify media id
  view: "front" | "back" | "side" | "detail" | "general";
};
type GalleryMedia = {            // what shoppers see; needs alt text
  mediaId: string;               // Shopify MediaImage gid
  provenance: "original_photo" | "studio_render" | "unknown";
  inspectedAs?: `gm${number}`;   // set when this image was sent to the vision call for ITS OWN alt
  currentAlt: string;
};
type AltPlan = { mediaId: string; inspectedAs: `gm${number}`; current: string; proposed: string; claimIds: string[]; action: "replace" | "keep" };
```

- **Provenance is recorded, not guessed.** New table `media_provenance (shopify_media_id PK, kind, source_ref, recorded_by, recorded_at)`.
  - Studio's push to Shopify writes `studio_render` rows for every image it uploads. The Studio push path knows the render id.
  - A one-off backfill marks existing media with `studio_render` from the push records in `studio_matrix_state` and R2 handoff keys.
  - The filename regex (`/files/studio-\d+-\d+\.`) is used **only as a fallback** for media with no record, and sets `unknown` rather than `studio_render` when the two disagree.
  - `unknown` is never evidence.
- **Evidence:** `EvidencePhoto` comes from the R2 Studio refs plus gallery media with provenance `original_photo`. Only these may support `visual` claims.
- **Alt text:**
  - Every gallery image (renders included) is inspected **as itself** in a separate vision call, and gets a `gm` id.
  - Alt describes what that image shows: product name, colour, how it is worn or shown.
  - Alt may contain non-visual terms only with a cited fact claim (D3 rule 2 applies).
  - The model's outfit is described only if it is visible in that image. Nothing is inferred from claims.
- **Validation:**
  - every `AltPlan.inspectedAs` maps to exactly one inspected `GalleryMedia`;
  - no duplicates;
  - `proposed` is 10–160 chars;
  - media not inspected → `keep`.

## D6. Research and pilot

### D6.1 Demand and difficulty (replaces B2 step 3)

- Keyword Planner `competition` / `competitionIndex` measure **paid-ad competition**. They are recorded as `ads_competition` and **not** used as organic difficulty.
- **Organic fit** is judged per priority cluster (the top ~30 by demand × business value) from a manual look at the live search results. It is recorded in `page_targets`:
  - `serp_types` (retailer category pages / product pages / marketplaces / editorial);
  - `carbon_page_fit` (`strong` | `weak` | `none`);
  - `notes`.
  - We do not scrape Google. The owner or Claude checks it in a browser.
- **Branded classification:**
  - `branded`: contains `carbon` / `shopcarbon` (any locale spelling).
  - `name_ambiguous`: contains a product name that is also a common word or first name (Alex, Memories, Bradley, Successful…). These are **not** counted as branded.
  - A `name_ambiguous` query moves to branded only with evidence of CARBON intent: it also contains a Carbon-specific term (the full product name + category as we title it), **and** Search Console shows our product page at average position ≤ 3 with CTR ≥ 20% for it.
  - `nonbranded`: everything else.
  - All three are reported separately. `name_ambiguous` is excluded from the primary outcome.

### D6.2 Pilot design (replaces B7 "Decide")

- **Pairs.** Candidate products have ≥ 50 nonbranded impressions in the 56-day baseline. They are matched into pairs on category, baseline nonbranded clicks (log scale), price band and stock depth.
- **Assignment.** Within each pair, a coin flip with a seeded RNG (the seed is recorded in `seo_runs.scope`) assigns treatment and control. Pairs where either product goes out of stock or into a promotion are dropped by a rule fixed before the start.
- **Power check before start.** From the baseline clicks, compute the minimum detectable effect for the planned pair count (bootstrap on pair DiD, 80% power, α = 0.05).
  - If the MDE is > 30%, add pairs (up to all eligible) or extend the window. The result is recorded.
  - 40 pairs is the starting assumption, not a promise of power.
- **Primary outcome (prespecified, one only):** nonbranded organic clicks per product (Search Console, page-level, `name_ambiguous` excluded).
- **Comparison.** Per pair: DiD = [log(1+clicks_after) − log(1+clicks_baseline)]_treatment − [same]_control.
  - Baseline is days −56…−1 before publish.
  - After is days +28…+56. Days 0–27 are excluded for recrawl.
  - Estimate = mean pair DiD, with a 95% bootstrap CI (10,000 resamples of pairs).
- **Decision:**
  - **Success:** CI lower bound > 0 **and** estimate ≥ log(1.10).
  - **Harm:** CI upper bound < 0 → revert treatment (D4.3) and revise.
  - **Inconclusive:** anything else, including a tie. This does **not** count as success. Options: extend once by 4 weeks with the same analysis, or stop. A rollout decision on an inconclusive result is the owner's explicit call and is recorded as such.
- **Secondary outcomes (reported with CIs, no decision):** organic landing sessions, add-to-cart, orders, revenue; branded and `name_ambiguous` clicks.
- **Shopping, separated:**
  - Preferred, if the D1 proof passes: during the pilot, treatment products get a supplemental Shopping title/description that **equals their pre-pilot Shopping text**. The Shopping channel is then unchanged, and the pilot measures organic only.
  - Shopping changes are tested separately afterwards, using Google Ads per-product reporting with campaign and budget changes logged.
  - If D1 fails, the SEO-title change also changes Shopping (E1). The pilot is then reported as a **bundled** intervention: organic and Shopping results shown separately, with every campaign budget or bid change in the window listed.
- **No collection-content changes** during the pilot for collections that contain pilot products. Otherwise the change is listed as a confound.

## D7. Technical and measurement audit first (moves B4 to step 1)

The initial technical audit is **done for the public checks** (D0 E9–E13). Its fixes are small and independent of the content engine:

| # | Fix | Effort | Needs |
|---|---|---|---|
| T1 | De-duplicate the SEO titles `X - X` (en/es/pt). **Corrected count (2026-10-11 scan): 31 active products** have a repeated SEO title (566 is how many Shopping titles *copy* the SEO title, not how many are doubled), and **4 of them carry another product's title** (alia-crop-tank, furry-top-set, remi-jacket-set, remi-pants-set). One-off cleanup to `{product name} \| Carbon` in each language (glossary names), with no new claims. | small | owner OK |
| T2 | Archived product → 301 to its main collection (Shopify URL redirects), instead of 404 | small | owner OK |
| T3 | Store locator: title "Carbon Store — 6250 Edgewater Dr, Orlando" + `ClothingStore` JSON-LD (address, hours, geo, phone) | small | owner OK + hours |
| T4 | GTIN: none to add. Barcodes are internal 7-digit style codes (E7). Keep `identifierExists=false`. **Option:** send variant SKU as `mpn` via the supplemental source (low value; decide after D1) | none / small | decision |

Still to do, needing Search Console access (B1):

- coverage / "Crawled – not indexed" by template;
- Product snippets and Merchant listings enhancement reports;
- query → page data for D6.

Measurement check, run before the pilot:

- Shopify / GA4 organic landing-page sessions and orders reconcile within ±10% of each other for 28 days;
- Google Ads per-product Shopping report exists for the pilot products.

## D8. Build order (replaces the rev-2 list)

1. **Access and audit:**
   - Search Console access (B1);
   - D7 remaining checks;
   - measurement check;
   - owner decisions on T1–T3.
2. **D1 one-product proof:** precedence, enum, Spanish, labels preserved, refresh survival, with the proof log. No GMC text writes before it passes.
3. **Data layer and writers:**
   - migration 0107 (D1.4, D2.2, D4.1, `product_facts`, `media_provenance`, `resource_type`/`resource_id` on `seo_items`);
   - `gmc-supplemental-writer`, with Sync ads moved onto it (labels only, behaviour unchanged);
   - D4 executor with the D4.4 tests.
4. **Engine:** D3 validator with golden tests, D5 media, D2 artifacts. Then the **12-product eval with no writes**, reviewed by the owner for voice, evidence, set contents and image mapping.
5. **Backfill** of the AI flag for today's v1 text (B5), only through the D1 passing config and the writer.
6. **Pilot** (D6.2) → checkpoint → waves. Collections (B3) and local (B8) are scheduled by measured opportunity. T1–T3 can ship in step 1 if the owner approves.

`seo_items` gains `resource_type text NOT NULL DEFAULT 'product' CHECK (resource_type IN ('product','collection','page'))` and `resource_id text NOT NULL`. `UNIQUE (run_id, resource_type, resource_id)` replaces `UNIQUE (run_id, product_id)`. `product_id` is kept as a nullable legacy column for products.

## D9. Decisions needed from the owner (rev 3)

1. Grant Search Console access (B1): service account `claude-merchant-reader@shopify-ai-catalog.iam.gserviceaccount.com`, Restricted.
2. Approve T1 (fix the doubled titles now, in all three languages), T2 (301 for archived products) and T3 (store page title + schema; confirm the opening hours).
3. Supplier spec sheets (composition, care): do they exist? Without them, the copy describes only what is visible.
4. Sets: which set products are **sold together** in one purchase, and which pair with a separately sold piece?
5. Label and patch text in descriptions: never, or only on items where you call it a selling point?
6. Approve the D1 one-product proof on a low-traffic product (it briefly changes that product's SEO title in Shopify to a test string).

## D10. Review point → answer

| Rev-2 review point | Answer | Where |
|---|---|---|
| 1. Ordinary beats structured; enum; insert race | Controlled 6-step proof with a decision rule and no silent fallback; `TRAINED_ALGORITHMIC_MEDIA`; one writer with a per-offer lock and local full-input state; Sync ads moved onto it | D1 |
| 2. Separate organic / Shopping; per-language feed; resync | Two artifact families; deterministic variant title from the variant's own options; Spanish from Translate; listings enumerated; dirty-flag sync job | D2 |
| 3. Claim ids must constrain words and values | Non-empty claim ids; exact fact-value match; lexicon over every field; `%` regex fixed; performance class; leather exception removed; sets split into two facts | D3 |
| 4. Resume and revert | Per-op ledger with before/after; one executor adopts our own landed writes; advisory lock + unique index; revert restores metafields, tags and GMC history | D4 |
| 5. Evidence vs gallery ids; provenance | Separate `ev` / `gm` id spaces; `media_provenance` table recorded at Studio push; filename only as fallback | D5 |
| 6. KP competition; branded; pilot rules | Ads competition kept apart from organic fit; `name_ambiguous` class; seeded randomisation in pairs; one primary outcome; DiD with bootstrap CI; explicit success / harm / inconclusive; Shopping frozen or reported as a bundle | D6 |
| 7. Audit earlier; resource ids | Public audit done (E9–E13) with fixes T1–T4; GSC part is step 1; `resource_type` / `resource_id` | D7, D8 |
| Live findings need evidence | Scripts and raw outputs committed; a causal marker test is added | D0, D1.2 step 0 |

## D11. Search Console data and owner answers (added 2026-10-11, after rev 3)

**Access already exists.** The service account `claude-merchant-reader@…` has been a Full user on `sc-domain:shopcarbon.com` since 2026-09-19. V3 was wrong: it tested the Ads OAuth token, not the service account. The pull script is `docs/seo/evidence/gsc-pull.mjs`. Raw output is not committed: it contains query strings.

| # | Finding (Search Console, web search) | Number |
|---|---|---|
| G1 | Last 90 days (2026-07-12 → 10-09): clicks / impressions | 1,221 / 41,919 |
| G2 | Branded (contains carbon / shopcarbon) share of clicks | **1,164 of 1,221 (95%)**; nonbranded 57 clicks on 21,986 impressions |
| G3 | Clicks by template (en): home 1,230 · collections 491 · products 209 · other 118. Spanish products 35, Portuguese products 14 | page-level, 90 days |
| G4 | Nonbranded clicks to **all product pages over 16 months** (query × page rows) | **130** in total; 128 product pages have ≥ 50 nonbranded impressions in 16 months, 43 have ≥ 200 |
| G5 | The top "nonbranded" queries are mostly **other brands' names**: `benjamin black pants` (1,104 impressions), `alo set` (Alo Yoga), `alexis sweaters` (3,520), `andy jeans`, `nixon jeans` | This confirms D6.1's `name_ambiguous` class. These are not CARBON-intent queries. |
| G6 | Real generic demand where CARBON already appears: `cargo trousers streetwear` (pos 8), `zipper sneakers men` (pos 15–26), `biker jeans` (pos 31–43), `super-skinny-jeans-men` collection (1,254 nonbranded impressions), `matching-sets`, `shorts-1` | Mostly page 2–4 |

**Consequences for the plan (supersede parts of D6 and D8):**

1. **The product-page pilot as designed cannot be powered.** G4 averages under one nonbranded click per product per measurement window. Nonbranded organic clicks stay a reported metric, but the pilot's primary outcome becomes **nonbranded impressions per product** (log, DiD, same CI rules). This is a leading indicator. A positive result means "more visibility", not "more sales", and is reported that way.
2. **Shopping text is the larger product-text lever.** Paid and free Shopping listings use the feed title and description (E1/E2) on every product, every day. D1 and D2 move **ahead** of the organic pilot.
3. **Collections first for organic:** `jeans-men`, `pants`, `super-skinny-jeans-men`, `matching-sets`, `shorts-1`, `baggy-men`, plus `/pages/jeans` (9,290 impressions, 62 clicks). The B3 collection work moves to step 2 of the build order.
4. **T1** (de-duplicating the doubled titles) is still worth doing. It changes every Shopping title (E1) and every SERP snippet. It adds no claims.

**Owner answers (2026-10-11):**

| D9 # | Answer | Effect |
|---|---|---|
| 1 | Access exists | G1–G6 above |
| 2 | T1, T2, T3 approved | Ready to build on "you can start to build". **T3 is more urgent than thought:** the store-locator JSON-LD says `Place` named **"Florida Mall"**, but the page shows the CARBON SHOWROOM at 6250 Edgewater Drive, Suite 100, Orlando FL 32810, (407) 773-1399. Hours (from the page): Mon–Tue 12–7 PM, Wed closed, Thu–Sat 12–7 PM, Sun closed. |
| 3 | Supplier sheets: owner will check | Until then there are no material or care claims (D3) |
| 4 | Sets: use the existing WMS data | 163 set matrices in 75 groups (97 linked to Shopify). Each piece is **its own Shopify product at its own price**. The cart guard adds and removes pieces in lockstep, with `_carbon_set_solo` for buying one piece alone. So the fact is auto-derived, with no manual entry: `included_pieces = this piece only`; `sold_separately_match = carbon_set.partners`. Allowed copy: "Part of the River set — pair it with the River Bottom". Forbidden: "includes", "comes with", "two-piece set" on a single piece's page. |
| 5 | Labels: "not jeans label" | The **CARBON JEANS waistband or back label is never mentioned** in any SEO text. Other visible designed text and graphics (prints, embroidered words) may be described as design. |
| 6 | D1 one-product proof approved | Runs at build step 1 |

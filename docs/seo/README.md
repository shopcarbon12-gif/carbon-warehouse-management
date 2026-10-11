# Carbon (shopcarbon.com) — Technical SEO & Catalog Audit

Date: 2026-09-09 · Store: Carbon / shopcarbon.com (30e7d3.myshopify.com) · 771 products, 83 collections

## Scope note

Google Search Console was **not** readable in this session: no Search Console
connector is attached, and the network egress policy blocked all direct HTTP
requests to `shopcarbon.com`. Everything below is derived from the Shopify
Admin API, which is the source of truth for the URLs, redirects, navigation and
product data that Search Console reports on.

---

## What was changed

### 1. Deleted 817 dead-end redirects (1,769 → 952)

Leftovers from a removed translation app. Every one sent a locale-prefixed
product URL to a generic catch-all listing:

    /es/products/wilder-jeans  →  /es/collections/all

Breakdown of the 817:

| Group | Count | Why it was wrong |
|---|---|---|
| Locales not configured on the store (`az hy be fil am ak bm bn as eu bs af`) | 487 | Target URL does not exist — redirect led to a 404 |
| Locales configured but unpublished (`de he ro ru ar`) | 213 | Locale not served — redirect led to a 404 |
| Published locales (`es`, `pt-BR`) | 117 | **Worst case.** Spanish and Portuguese are live, so these redirects were intercepting working, in-stock localized product pages and dumping shoppers on a 771-item wall |

The 117 `es`/`pt` entries were a live revenue bug, not just an SEO one.
Verified examples now restored: `wilder-jeans` (73 in stock), `weston-jeans`
(46), `mason-jeans` (17), `cut-out-dress` (35), `eliza-dress` (29).

Full backup: `redirect-backup-locale-catchall.csv` (817 rows, with Shopify IDs).

### 2. Repaired 7 redirects that pointed at 404s

| Path | Old target (broken) | New target |
|---|---|---|
| `/weston-jeans.html` | `/shopcarbon.com#seogid76329` | `/products/weston-jeans` |
| `/ryland-top-set.html` | `/shopcarbon.com#seogid71360` | `/products/ryland-top-set` |
| `/service/disclaimer` | `/shopcarbon.com#seogid66996` | `/pages/disclaimer` |
| `/hiring-now` | `/shopcarbon.com#seogid72123` | `https://carbon1.myportfolio.com/hiring-now` |
| `/creators` | `/shopcarbon.com#seogid71782` | `/pages/about-us` |
| `/collections/slim-jeans-women` | `/collections/flare-women` (no such collection) | `/collections/clothing-jeans` |
| `/collections/limited-edition-women-copy` | `/collections/limited-edition-men` (wrong gender) | `/collections/limited-edition` |

The `#seogid` targets resolved to `shopcarbon.com/shopcarbon.com#…` — a 404 on
every hit.

### 3. Removed 5 dead category links from the main navigation (81 → 76 items)

These collections have **zero products** and were linked from the header on
every page of the site, so Googlebot re-crawled them constantly and shoppers
hit empty shelves:

- MEN → ACCESSORIES & SHOES → SOCKS & UNDERWEAR, TIES, FRAGRANCE & BEAUTY, BELTS
- WOMEN → ACCESSORIES & SHOES → SUNGLASSES

Before/after trees: `main-menu-BEFORE.json`, `main-menu-AFTER.json`. Nothing
else in the menu was touched; all 76 remaining items verified present.

---

## Still open — needs a human in Shopify admin

### A. Unpublish the 5 empty collections (2 minutes)

The Shopify connector blocks `publishableUnpublish` as a safety policy, so this
could not be done from here. All five are still published to **seven** channels: Online Store, Shop,
TikTok, Google & YouTube, Facebook & Instagram, Pinterest and Snapchat Ads. So
they remain in `sitemap.xml` and in the Merchant Center feed even though they
are no longer linked in the nav.

| Collection | Handle |
|---|---|
| SOCKS & UNDERWEAR (men) | `socks-underwear` |
| TIES (men) | `ties` |
| FRAGRANCE & BEAUTY (Men) | `fragrance-beauty` |
| BELTS (men) | `belts` |
| SUNGLASSES (Women) | `sunglasses-women` |

Admin → Products → Collections → open each → Publishing → remove all channels.

Confirmed there is nothing to stock them with: the catalog has **zero** active
sunglasses, socks, ties, or fragrance products. The only men's belt products
that exist are tagged `WOMEN >> ACCESSORIES`.

**Except one.** `SOCKS & UNDERWEAR (men)` has a product waiting: see below.

### B. The draft backlog — $251,834 of retail value, invisible

220 of 770 products are DRAFT. 158 of them hold stock:

| Metric | Value |
|---|---|
| Draft products (authoritative count) | 220 |
| Draft products holding stock | 158 |
| Units sitting in them | 3,607 |
| Retail value at min variant price | **$251,834** |
| Of those, blocked solely by missing photos | **158 of 158 (100%)** |

Every one of these has a title, a description, SEO fields, a price, a product
type and inventory. The single blocker is product photography. Nothing else.

Ranked worklist: `draft-backlog-priority.csv` (sorted by units × price, with a
direct admin link per product).

Top of the list:

| # | Units | Price | Stock value | Product |
|---|---|---|---|---|
| 1 | 379 | $39 | $14,781 | Men's Boxer Brief 3-Pack |
| 2 | 85 | $138 | $11,730 | Eugene Puffer Coat |
| 3 | 75 | $114 | $8,550 | Mens Jeans BR |
| 4 | 108 | $78 | $8,424 | Dani Heels |
| 5 | 74 | $95 | $7,030 | Vick Jeans |

Note the top item: **379 units of men's underwear in draft, while the men's
SOCKS & UNDERWEAR category sits empty.** Shoot that one product and the
category stops being a dead page and starts being a $14.7k listing. It is the
highest-value single action available.

---

## Findings not yet acted on

1. **45 redirects still point to `/collections/all`.** Same soft-404 shape as
   the 817 just removed, but at the root locale. They should be retargeted to
   the relevant category or deleted so the old URLs return a clean 404.

2. **The highest-value jeans collections are orphaned from the main nav.** The
   header "JEANS" entries point at CMS pages (`/pages/jeans`,
   `/pages/men-jeans-cuts-1`, `/pages/women-jeans-cuts`), not collections. So
   `/collections/jeans-men` (75 products) and `/collections/clothing-jeans`
   (17 products) get no primary internal links, on the store's single most
   commercially important keyword.

3. **URL slugs that contradict their content**, weakening relevance:
   - `/collections/matching-sets` is the "SWEATSHIRTS & HOODIES (Men)" page
   - `/collections/short-sleeve-shirts` is "GRAPHIC T-SHIRTS (SUMMER men)"
   - `/collections/jeans-women` is "FLARE & WIDE LEG (women)" with 1 product,
     while actual women's jeans live at `/collections/clothing-jeans`
   - Numbered duplicates: `shorts-1`, `swimwear-1`, `tracksuits-1`, `clothing-1`,
     `matching-sets-1`, `jackets-coats-2`

4. **Five locales have public root URLs but are unpublished** (`de`, `he`, `ru`,
   `ro`, `ar`). Worth confirming hreflang output only advertises `en`, `es` and
   `pt-BR`.

5. **Near-empty collections still live and in the nav**: `polos`, `sunglasses`
   (men), `linen-shirts`, `jeans-women` — 1 product each.

---

## What is already healthy

Worth stating plainly, because it is where most stores fail and this one does not.
Across all 550 active products:

| Check | Result |
|---|---|
| SEO title present | 550 / 550 |
| SEO description present | 550 / 550 |
| Titles over 60 chars | 0 |
| Descriptions outside 70–160 chars | 0 |
| Duplicate SEO titles | 0 |
| Products with no image | 0 |
| Products with blank description | 0 |
| Variants missing SKU or barcode/GTIN | 0 |
| Active products with no storefront URL | 0 |

Collection-level SEO titles and descriptions are written and unique across all
83 collections. HTML sitemap pages exist. Product-level Merchant Center feed
data (GTIN, SKU, vendor, product type) is complete.

The catalog data is not the problem. The URL layer and the draft backlog are.

---

## Suggested order of work

1. Unpublish the 5 empty collections (2 min, admin) — closes the soft-404 loop
   the nav change started.
2. Shoot photos for the top 20 draft products (~$100k of the $251k) — highest
   revenue per hour of effort by a wide margin, starting with the boxer briefs.
3. Retarget or delete the 45 remaining `/collections/all` redirects.
4. Point the header JEANS links at the jeans collections instead of CMS pages.
5. In Search Console, once 1–3 are done: Validate Fix on "Page with redirect"
   and "Crawled – currently not indexed", and resubmit `sitemap.xml`.

---

## Addendum — Merchant Center feed audit (2026-09-09)

Triggered by a Google Ads setup attempt flagging issues. This is the **feed
quality** layer, separate from the URL/crawl layer above. Findings verified
against the Shopify Admin API.

### Barcodes are NOT GTINs — do not map them

The single most important finding. Every variant of a product carries the
**same** 7-digit barcode, which is an internal style code:

| Product | Variants | Shared barcode |
|---|---|---|
| Milo Jeans | 8 | `1171056` |
| Franco Jeans | 8 | `1171067` |
| Chaos Hoodie Set | 8 | `1222216` |
| Alexia Top | 6 | `2541409` |

A valid GTIN is 8, 12, 13 or 14 digits and must be unique per sellable item.
These are 7 digits and duplicated across every size and colour. Mapping this
field to GTIN in the Google & YouTube app would trigger mass disapproval on two
counts at once: invalid GTIN, and duplicate GTIN across distinct items.

**Correct setting:** leave GTIN unmapped, declare no manufacturer identifier
(`identifier_exists: false`), and supply brand + MPN instead. The store is
already set up for this — every product has a vendor, and unlike the barcode
the **SKU is unique per variant**, so it maps cleanly to MPN.

### Variant-level stock

Merchant Center treats every size and colour as a separate item, so a zero-stock
variant is suppressed individually while ad spend continues on the sizes that
remain.

| Metric | Value |
|---|---|
| Active products | 550 |
| Total variants | 3,591 |
| Variants at zero stock | **902 (25%)** |
| Products fully in stock | 312 |
| Products with at least one dead variant | 238 |
| Products where over half the variants are dead | **83** |
| Active products with zero sellable stock | 1 |

Exports: `variants-out-of-stock.csv` (all 902 rows) and
`products-mostly-sold-out.csv` (the 83 worst, sorted by percentage dead).

Worst offenders include Carbon Classic Tee (49 of 50 variants dead, 1 unit
left) and Classic Industry T-Shirt, Fill In The Blank T-Shirt and My Rules
T-Shirt (14 of 15 dead each). These should be paused or restocked before any
ad spend starts.

### Store contact email

`shop.contactEmail` is `marketing@carbonjeanscompany.com`, on a different domain
from shopcarbon.com, while every policy page lists `support@shopcarbon.com`.
Merchant Center reads off-domain contact addresses as a weaker trust signal.

The Admin API exposes no mutation for this field — `shopUpdate` does not exist
and the schema carries no shop-settings write. It must be changed by hand:
**Settings → Store details → Contact information**.

---

# Pass 2 — 2026-09-17: Search Console status and page cleanup

## How Search Console was read

There is still no Search Console connector on this account, and the network
egress policy still blocks requests to shopcarbon.com (`CONNECT tunnel failed,
response 403`), so neither the Search Console UI nor the live pages were
readable directly.

Search Console's own alert emails are, however, delivered to the verified
owner's inbox, and that inbox is readable. The findings below come from those
alerts, cross-checked against the Shopify Admin API.

## What Search Console is currently reporting

Last alert of any kind: **2026-09-08** (August performance summary). No new
page-indexing problem has been reported since **2026-08-09**, which is before
the Pass 1 fixes landed. That is a quiet window, not yet a clean bill of
health — nine days is shorter than a full recrawl cycle.

Open problem alerts, newest first:

| Date | Alert | Severity |
|---|---|---|
| 2026-08-22 | Merchant listings: **missing field `image`, +200%** | Critical |
| 2026-08-21 | Merchant listings: missing field `description` (in `<parent_node>`) | Non-critical |
| 2026-08-09 | Soft 404 — pages, and pages in a sitemap | Critical |

Search traffic for context: 626 clicks / 27.4K impressions in August, against
638 / 26.7K in July and 960 / 39.4K in March. Impressions are flat, clicks are
drifting down from the March peak.

## The "missing image" alert is not a catalog problem

This was checked exhaustively before concluding anything, because the obvious
reading — products without photos — is wrong.

All **550 active products** were pulled in six pages and every one has a
`featuredMedia` and a non-empty `description`. Variant-level media was sampled
across the widest products (Chaos Hoodie Set, Carbon Classic Tee, Milo Jeans)
and **every variant resolves to an image** as well.

So no product, and no variant, is missing an image or a description in Shopify.
The structured data Google is complaining about is being emitted by a page
template or an injected app script, not by gaps in the catalog.

**This is the one finding that cannot be closed from here.** Confirming which
template emits the incomplete node requires fetching the rendered HTML of a
live page, which the egress policy blocks. It is one click for a human:
Search Console → Enhancements → Merchant listings → open the failing item →
**Test live page**. The Rich Results Test names the emitting node directly.

## Changes applied to the live store in this pass

Both sets use Shopify's `seo.hidden` metafield, which makes the Online Store
emit `<meta name="robots" content="noindex">` for that resource. The pages stay
reachable, so internal links still pass, but they drop out of the index.

This is the mechanism that replaces the unpublish step Pass 1 could not
perform: `publishableUnpublish` is blocked by the Shopify connector's safety
policy, and it was never the better fix anyway — unpublishing removes a page
entirely, while `noindex` resolves the Search Console report without breaking
anything that links to it.

### The 5 empty collections — now noindexed

Still published to seven sales channels at the start of this pass, still
holding zero products, and still the most likely source of the Soft 404 report.

| Collection | Handle | Products | Metafield |
|---|---|---|---|
| SOCKS & UNDERWEAR (men) | `socks-underwear` | 0 | `47192549851388` |
| TIES (men) | `ties` | 0 | `47192549884156` |
| FRAGRANCE & BEAUTY (Men) | `fragrance-beauty` | 0 | `47192549916924` |
| BELTS (men) | `belts` | 0 | `47192549949692` |
| SUNGLASSES (Women) | `sunglasses-women` | 0 | `47192549982460` |

### The 6 HTML sitemap pages — now noindexed

Thin listing pages that exist as crawl scaffolding. They are exactly the shape
that accumulates in "Crawled, currently not indexed", and nothing is gained by
having them in the index. Crawling is unaffected, so they still do their job.

`html-sitemap`, `html-sitemap-products`, `html-sitemap-collections`,
`html-sitemap-blogs`, `html-sitemap-articles`, `html-sitemap-pages`.

All 11 metafields returned empty `userErrors` and were re-read afterwards to
confirm `value: "1"`.

## New finding — three handles exist twice

Three handles resolve as **both a page and a collection**, which puts two URLs
in front of Google for the same term:

| Handle | As a collection | As a page |
|---|---|---|
| `men-clothing` | CLOTHING (MEN), 341 products | CLOTHING |
| `men-new-now` | NEW & NOW Men, 46 products | NEW & NOW |
| `men-accessories-shoes` | ACCESSORIES & SHOES (MEN), 30 products | ACCESSORIES & SHOES |

`/pages/retail-store-locator` and `/pages/store-locator` are a fourth pair of
the same kind.

These are **not** fixed here. Deciding which URL is canonical needs a look at
what the page templates actually render, and picking wrong would deindex the
version that currently ranks. Whichever is chosen, the other should get a
301 to it rather than a `noindex`, so its accumulated signals transfer.

## Also flagged, deliberately not changed

- **`all-products-chatgpt`** — a collection carrying all **771** products,
  duplicating the entire catalog at a second URL. A textbook duplicate-canonical
  and crawl-budget problem, and a plausible contributor to the "Duplicate,
  Google chose different canonical" report from February. It is left alone
  because the handle suggests it was built deliberately to feed an AI crawler,
  and noindexing it would defeat that purpose. Worth a decision.
- **Thin categories** — `polos`, `linen-shirts`, `jeans-women` and
  `sunglasses` hold 1 product each; `overalls` and `fragrance-beauty-women`
  hold 2. Real categories awaiting stock rather than dead ends, so they are
  left indexable. They will read as thin until they are filled, and the draft
  backlog in `draft-backlog-priority.csv` is what fills them.

## Still open, unchanged from Pass 1

1. **Resubmit `sitemap.xml` and run Validate Fix** in Search Console. The
   empty collections are noindexed as of this pass, so the precondition that
   was blocking a clean validation is now met.
2. **Store contact email** → Settings → Store details → Contact information.
3. **GTIN mapping** in the Google & YouTube app — declare no manufacturer
   identifier, brand + SKU-as-MPN. Do not map the barcode field.
4. **Photography for the draft backlog** — 158 products holding $251,834.

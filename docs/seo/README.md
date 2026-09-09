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
could not be done from here. All five are still published to **Online Store,
Shop, Google & YouTube, Facebook & Instagram, Pinterest and Snapchat Ads**, which
means they remain in `sitemap.xml` and in the Merchant Center feed even though
they are no longer linked in the nav.

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

212 of 771 products are DRAFT. 158 of them hold stock:

| Metric | Value |
|---|---|
| Draft products with stock | 158 |
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

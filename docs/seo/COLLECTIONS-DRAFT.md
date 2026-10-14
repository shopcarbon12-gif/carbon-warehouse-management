# Collection pages — draft for approval

**2026-10-11.** Nothing is published yet. Search data: Search Console, last 180 days of queries for each collection URL. Stock: active, in-stock products.

## What the data says

- **People reach collections by searching "carbon …".** The examples, with how often Google showed the collection:

  | Search | Collection | Times shown |
  |---|---|---|
  | carbon jeans | men's jeans | 450 |
  | carbon jeans for men | men's jeans | 268 |
  | carbon pants | pants | 366 |
  | carbon clothing brand | Men | 1,053 |
  | carbon jeans women | women's jeans | 81 |

  Generic searches without "carbon" (for example "baggy jeans men") rank on page 3–10 and bring almost no clicks.
- **"carbon clothing brand" and "carbon clothing" rank #2 but almost nobody clicks**: 1,053 + 981 times shown, 9 clicks. A clearer title can help there.
- **Three collection URLs show something different from what they say** (structural fixes below). The worst: Google sends "carbon jeans women" (position 3) to `/collections/jeans-women`, which holds **1 flare product**. The real women's jeans (17) are at `/collections/clothing-jeans`.
- **The current Google titles and descriptions use the old clichés**: "trendy, affordable", "elevate", "cozy", "crafted for comfort". The on-page intros are already good fit guides and mostly stay.

## A. Structural fixes (URL ↔ content)

Each rename keeps the old URL working with a 301. I also update the theme templates and menus that link to the old address, listed under "Also updates".

| Today | Problem | Fix | Also updates |
|---|---|---|---|
| `jeans-women` = FLARE & WIDE LEG (1 product) | Takes the "carbon jeans women" traffic | rename → `flare-wide-leg-jeans-women` | main-menu "FLARE & WIDE LEG JEANS", `page.women-jeans-cuts` |
| `clothing-jeans` = WOMEN JEANS (17) | The real women's jeans sit on an unrelated URL | rename → **`jeans-women`** (old `clothing-jeans` → 301) | footer nav, home, `page.jeans`, `collection.clothing-women`, `page.women-dress-cuts`, `page.women-jeans-cuts` |
| `matching-sets` = SWEATSHIRTS & HOODIES (Men) | URL says sets, page shows hoodies | rename → `sweatshirts-hoodies-men` | main-menu "SWEATSHIRTS & HOODIES", `collection.clothing` |
| `matching-sets-1` = MATCHING SETS (women) | The sets live on a "-1" URL | rename → **`matching-sets`** | main-menu "MATCHING SETS" |
| `super-skinny-jeans-men-copy` = ANKLE ZIP | "-copy" URL | rename → `ankle-zip-jeans-men` | main-menu, `page.men-jeans-cuts-2` |
| `shorts-1` = SHORTS (Men) | "-1" URL | rename → `shorts-men` | main-menu "SHORTS", `collection.clothing`, `page.clothing-2` |

## B. Copy

The rules are the same as for products: what the page holds, the fit as Carbon defines it, no fabric or feel claims, no clichés. Each intro links to the related fits, so Google and shoppers can move between them.

### Men's Jeans — `jeans-men` (63 live)
- **Google title:** Men's Jeans – Super Skinny, Skinny, Slim & Baggy | Carbon
- **Google description:** Carbon men's jeans in every fit: super skinny, skinny, slim, ankle zip and baggy. Light to dark washes, clean or ripped.
- **Intro:** All Carbon men's denim in one place. Choose your fit — [super skinny](/collections/super-skinny-jeans-men), [skinny](/collections/skinny-jeans), [slim](/collections/slim-jeans-men), [ankle zip](/collections/ankle-zip-jeans-men) or [baggy](/collections/baggy-men) — then filter by size or color, or browse all men's jeans below.

### Super Skinny Jeans (Men) — `super-skinny-jeans-men` (35 live)
- **Title:** Men's Super Skinny Jeans – Ripped & Clean | Carbon
- **Description:** Carbon's tightest fit: men's super skinny jeans, narrow from thigh to ankle in a full-length leg. Light to dark washes, clean or ripped.
- **Intro:** current text kept, plus: "Prefer it cropped? See [ankle zip](/collections/ankle-zip-jeans-men)."

### Skinny Jeans (Men) — `skinny-jeans` (12 live)
- **Title:** Men's Skinny Jeans – Tapered to the Ankle | Carbon
- **Description:** Carbon men's skinny jeans: slim through the thigh and tapered to the ankle, with a little more room than super skinny. Clean or ripped.
- **Intro:** kept as is.

### Slim Jeans (Men) — `slim-jeans-men` (4 live)
- **Title:** Men's Slim Jeans | Carbon
- **Description:** Carbon men's slim jeans: slim through the leg with a gentle taper, an everyday fit that works dressed up or down.
- **Intro:** "…tailored without feeling tight…" becomes "…tailored, not tight…". The rest is kept.

### Ankle Zip Jeans (Men) — `ankle-zip-jeans-men` (12 live)
- **Title:** Men's Ankle Zip Jeans – Cropped Super Skinny | Carbon
- **Description:** The Carbon super skinny fit, cut shorter and finished with a zip at the ankle to show off your sneakers.
- **Intro:** kept as is, without the "easy to get on and off" promise.

### Baggy Jeans (Men) — `baggy-men` (11 live)
- **Title:** Men's Baggy Jeans – Loose, Straight Leg | Carbon
- **Description:** Carbon men's baggy jeans: loose through the hip and thigh with a straight, roomy leg made to stack over sneakers.
- **Intro:** "Comfortable, laid-back and made to stack…" becomes "Laid-back and made to stack…".

### Pants (Men) — `pants` (21 live)
- **Title:** Men's Pants – Cargo, Sweatpants & Evening Pants | Carbon
- **Description:** Carbon men's pants beyond denim: cargo pants, sweatpants and evening pants. Filter by size or color.
- **Intro:** Men's pants beyond denim: cargos, sweatpants and evening pants. Filter by size or color, or browse all men's pants below. (The current text says "chinos", but the collection has none.)

### Shorts (Men) — `shorts-men` (24 live)
- **Title:** Men's Shorts – Denim Shorts & Short Sets | Carbon
- **Description:** Carbon men's shorts: ripped and clean denim shorts, plus matching short sets. Filter by size or color.
- **Intro:** Men's denim shorts, ripped or clean, and matching short sets for warm weather. See all [summer sets](/collections/summer-sets-men). Filter by size or color, or browse all men's shorts below.

### Sweatshirts & Hoodies (Men) — `sweatshirts-hoodies-men` (25 live)
- **Title:** Men's Hoodies & Sweatshirts – Graphic Prints | Carbon
- **Description:** Carbon men's hoodies and sweatshirts with bold graphic prints, plus matching hoodie sets. Filter by size or color.
- **Intro:** Men's hoodies and sweatshirts, from lounging to the street, plus matching hoodie sets. ("for comfort" removed.)

### Matching Sets (Women) — `matching-sets` (37 live)
- **Title:** Women's Matching Sets – Coordinated Tops & Bottoms | Carbon
- **Description:** Carbon women's matching sets: a coordinated top and bottom for an instantly put-together look. Filter by size or color.
- **Intro:** kept as is.

### Women's Jeans — `jeans-women` (17 live)
- **Title:** Women's Jeans – Skinny, Relaxed, Flare & Wide Leg | Carbon
- **Description:** Carbon women's jeans in skinny, relaxed, flare and wide-leg fits. Choose your fit, then filter by size or color.
- **Intro:** All Carbon women's denim in one place: [skinny](/collections/skinny-jeans-women), relaxed, and [flare and wide leg](/collections/flare-wide-leg-jeans-women). Choose your fit, then filter by size or color, or browse all women's jeans below.

### Men — `men` (170 live)
- **Title:** Men's Clothing – Jeans, Tees, Shirts & Jackets | Carbon
- **Description:** Carbon menswear: jeans in every fit, graphic tees, shirts, jackets, hoodies and sets. Filter by category, size or color.
- **Intro:** kept as is.

## After publishing
- Spanish and Portuguese for these pages go out of date. Run Shopify's auto-translate on collections, then I check them with the same brand and glossary rules.
- Each change is backed up first (old handle, title, SEO, intro), so any one of them can be undone.

## Done — 2026-10-13
- Part A live: the 6 handles renamed in order; 301s for `clothing-jeans`, `matching-sets-1`, `super-skinny-jeans-men-copy`, `shorts-1` (Shopify applies them under /es and /pt too). `jeans-women` and `matching-sets` were reused on purpose, so they have no redirect. 8 older redirects re-targeted (straight to the new handle; men's items no longer sent to women's pages).
- Theme: Shopify rewrote collection pickers and `shopify://` links itself; plain-URL links fixed in page.jeans, page.women-dress-cuts, page.women-jeans-cuts and the footer snippet; size-guide fallback (`carbon-size-guide-router`, `product-information`) now also knows `ankle-zip-jeans-men`.
- WMS: collection-mapping rule `COLLECTION: clothing-jeans` → `jeans-women`; seed handles updated; cached handles in `shopify_collection_menu_nodes` refreshed (mappings were already by collection id).
- Part B live: SEO title + description (sent together) and intros on all 12; ES + PT written by hand with the glossary (80 fields), no outdated flags.
- Backups: `evidence/collections-backup-2026-10-13.json` (handles, SEO, intros, menus, redirects), `evidence/collections-translations-backup-2026-10-13.json`.

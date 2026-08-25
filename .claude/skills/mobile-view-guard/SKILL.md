---
name: mobile-view-guard
description: Binding rules for ALL mobile-view work on the WMS web app. Load whenever editing UI components, Tailwind classes, or CSS for phone/mobile rendering, responsive behavior, or touch support. Enforces the desktop-pixel-identical guarantee.
---

# Mobile-View Guard — binding rules for wms.shopcarbon.com responsive work

These rules come from the 2026-08-24 mobile-view overhaul plan (Dropbox/elior perez/wms-mobile-view-uiux-plan-2026-08-24.html). They are BINDING for any change that touches UI rendering.

## The prime directive

**Desktop (≥768px) must stay pixel-identical.** Every existing class token defines current desktop behavior. Therefore:

1. **NEVER rewrite or remove an existing class token.** Express ALL mobile changes as *additive* `max-md:` variants, below-768px `@media` blocks, or new sibling elements gated `md:hidden`.
   - ✅ `w-80` → `w-80 max-w-[85vw]` (max never binds at md+)
   - ✅ add `max-md:min-w-[560px]` next to `min-w-[1200px]`
   - ❌ `w-80` → `w-[85vw] md:w-80` (re-declares desktop — forbidden)
   - ❌ `p-5 md:p-7` → new spacing scale (forbidden)
   - Exception: `X md:X` re-declaration is allowed ONLY when `max-md:` cannot express the change (e.g. changing a base to smaller then restoring identical desktop value behind `md:`); the `md:` value must be byte-identical to the old base and called out in the commit message.
2. **Never branch render output on `window.innerWidth`/`matchMedia` during render** — hydration mismatch. Dual layouts = CSS visibility gating (`hidden md:block` + `md:hidden` siblings). `matchMedia` allowed only for *behavior* in effects/handlers.
3. **The Flutter app (`mobile/carbon_wms/`) is permanently out of scope.** Never touch it for web work.
4. **No new UI dependencies** (vaul, Radix, framer-motion, sheet libs). The codebase's overlay + translate idioms cover everything.

## Standard recipes (use these exact patterns)

- **Touch target floor:** 44px at <md. Icon buttons: `max-md:min-h-11 max-md:min-w-11 max-md:flex max-md:items-center max-md:justify-center`. Inline text buttons: `max-md:py-2` bumps. Hit-area without layout shift: wrap in label/span with `max-md:-m-2 max-md:p-2`.
- **Checkboxes:** `max-md:h-5 max-md:w-5` (or h-6/w-6 for glove targets) — never `transform: scale()`.
- **Numeric entry:** `type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off" enterKeyHint="done"` (decimal → `inputMode="decimal"`). Never `type="number"`.
- **iOS focus-zoom:** any input a phone user focuses needs ≥16px font at <md: `max-md:text-base`.
- **Heights in mobile overrides:** `dvh` never `vh` (`max-md:max-h-[85dvh]`). Never rewrite desktop `vh` values.
- **Windowed modal → full-screen sheet:** on centering wrapper add `max-md:p-0 max-md:items-stretch`; on panel add `max-md:h-full max-md:max-h-none max-md:max-w-none max-md:rounded-none`. Keep the same JSX tree.
- **Bottom action bars:** in-flow flex `order` within the modal's flex column — never `position:fixed` (iOS keyboard pans fixed elements away). Pinned bars get opaque `max-md:bg-[var(--wms-surface)]`.
- **Hover-only affordances:** Tailwind v4 gates `hover:` behind `@media (hover:hover)` — phones never see them. Reveal-on-hover actions: `opacity-100 md:opacity-0 md:group-hover:opacity-100`. Touch feedback: `active:` variants. Mouse-only chrome (resize grips, overlay scrollbars): `hidden md:block`.
- **Table column pruning:** hide th and its exact td twin in lockstep (`max-md:hidden` on both) — mismatched cells silently corrupt column alignment.
- **Sticky first column:** `max-md:sticky max-md:left-0` + OPAQUE background (`max-md:bg-[var(--wms-surface-elevated)]`) + inset box-shadow separator (not border — border-collapse detaches from sticky cells).
- **Popovers:** clamp with `max-w-[calc(100vw-2rem)]`; dismiss via `pointerdown` not `mousedown`.
- **Safe area:** fixed bottom chrome needs `pb-[env(safe-area-inset-bottom)]`; `viewportFit: "cover"` and safe-area paddings ship together.
- **Never** `maximumScale: 1` / `userScalable: false` (a11y violation).
- **Scroll containment in sheets:** `max-md:overscroll-contain`; body-scroll locks must be media-guarded and desktop-invisible.
- **Autofocus:** gate programmatic focus/autofocus behind `matchMedia('(hover: hover)')` — keyboard must not pop over content on phones.

## Z-index & shell facts

- Shell header z-30 · drawer mask z-40 · drawer z-50 · sync floater z-[120] · Categories m3 chrome z-200..260 (drawer bumps to z-[280]/[290] there) — check collisions before adding fixed chrome.
- The shell header renders on DESKTOP too when the sidebar is unpinned — every header edit must be md-gated.
- Root font is 19px (22px XL) at md+ by design; phones get 16px via the globals.css media query — don't "fix" desktop rem math.
- Same-route nav taps must full-reload (see Sidebar handleSameRouteRefresh) — replicate in any new nav surface.

## Verification gate (every change set)

1. Desktop screenshot diff vs baseline (1440×900, light+dark) = **zero change** or the change is rejected.
2. Mobile check at 390×844: no page-body horizontal scroll, primary action reachable without panning, tap targets ≥44px.
3. `npm run build` passes.

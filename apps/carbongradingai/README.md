# CarbonTools (was CarbonGradingAI) — GradingAI, Catalog, Bulk Studio, Social

**Since 1.3.0 (owner, 2026-10-24) the app is CarbonTools.** Same package and signing key, so phones
update in place. Four tabs:
- **GradingAI** (the old Home): measuring. The Guide and the grading catalog search are inside it,
  under Scan tag.
- **Catalog**: CarbonWMS's own Inventory › Catalog (`/api/inventory/catalog?view=grid`). It shows
  live tags at the login's location.
- **Bulk Studio**: unchanged.
- **Social**: CarbonCast (`/api/marketing/*`, admin). Lists posts by day (Eastern), approves each
  post on its own or asks for changes or cancels it, holds the publishing switch (with a confirm),
  and shows the best hours.

The WebView still adds ` CarbonGradingAI` to its user agent, because the web layout keys on it.

## GradingAI — measure a garment from one photo

Native Kotlin app (Jetpack Compose + ARCore), package `com.shopcarbon.gradingai`. The phone's
**time-of-flight depth sensor** measures the table, the photo is squared up onto it at an exact
scale, and the garment's points of measure are placed on the photo — outline points on the phone at
once, seam points by the WMS's AI assist a few seconds later. Results save straight into the WMS
(`size_grading_measurements`) on every colour of the size and every product of its cut group.
Plan: claude.ai artifact `U8mhLmEQvrP31ErvyWnHgG` (v3, 2026-10-13). Fully separate from the
handheld app (`mobile/carbon_wms`) and CarbonWMS-PC (`apps/carbonwms-pc`).

**Phones:** Galaxy Note10+ (SM-N975), Note10+ 5G (SM-N976), S20+ (SM-G986), S20 Ultra (SM-G988) —
the only Samsungs with a rear ToF sensor ARCore uses. Any other phone: "not supported", or **test
mode** (Settings) with ARCore depth-from-motion — those scans go to the review list only and are
never written to an item.

## What lives where (desktop changes reach the phone without an update)

| Part | Where | Reaches the phone |
|---|---|---|
| Garment types, point lists, standard definitions, laying text | `lib/size-grading/grading-app-profiles.ts` → `GET /api/grading-app/config` | next app start |
| Guide pictures + their line ends | `public/size-grading/guide/app/*.webp`, `lib/size-grading/grading-app-guide*.{ts,json}` | next app start |
| AI assist (model, prompt, close-up agent) | `lib/server/size-grading-agent.ts`, `GRADING_APP_AI_MODEL` (default `gpt-6-astra`), `GRADING_APP_AI_SCOPE` (`hard`/`all`) | immediately |
| Studio, SEO writer | WMS screens in a WebView (`/inventory/catalog?matrix=…&mtab=studio|seo`) | immediately |
| Saving, size check, queue, cut groups, review | `lib/server/grading-app.ts`, `app/api/grading-app/*` | immediately |
| Camera, depth, cut-out, outline points, editor | this APK | app update (Settings → Update) |

## How a measurement is made (`measure/Pipeline.kt`)
1. ARCore session with `DepthSensorUsage.REQUIRE_AND_USE` and the largest CPU image (`ar/ArCamera.kt`).
   Live: RANSAC plane fit on raw depth 4×/s → distance, tilt, surface; ML Kit cut-out 1×/s → coverage;
   pose history → stillness. Auto-capture when all green and still for `holdStillMs`.
2. Capture: camera image + raw depth + confidence + intrinsics. Plane refit on every depth point.
3. `ar/Rectifier.kt`: homography from the plane → squared-up photo at the native scale, turned upright.
4. `vision/Segmenter.kt`: ML Kit subject segmentation (colour cut-out fallback).
5. Garment height from depth inside the cut-out → scale × d/(d−h) (the garment lies above the table);
   then the phone's calibration factor (Settings → Depth sensor check).
6. `measure/Outline.kt`: Size AI's lists from the silhouette; points it cannot see are "unsure".
7. AI assist: `POST /api/grading-app/assist` with the photo and the seam + unsure points.
8. Precision editor (drag any end, magnifier, undo) → `POST /api/grading-app/scans` (offline queue in
   `sync/ScanStore.kt`, WorkManager retry; the scan id makes retries idempotent).

## Build, test, release
```bash
bash apps/carbongradingai/scripts/build-release.sh      # unit tests + ~/CarbonToolsRelease/CarbonTools V<version>.apk
```
First run created the release keystore (`keys/`, `key.properties`, gitignored; backup in
`~/CarbonGradingAIRelease/keys-backup/`) — every future APK must be signed with it.
Outline test on the guide pictures: `./gradlew testDebugUnitTest -PgradingTestDir=<dir with profiles.json and raw/*.rgb>`.
Version: `appVersionName` in `app/build.gradle.kts` (dotted only). Publish an update:
`POST /api/grading-app/releases` (admin; multipart `version`, `apk`, `notes`) — the phone offers it in Settings.

## Phase 3 — the app's own point model
Every saved scan keeps the photo (R2 `grading-scans/…`, copy in Dropbox › CarbonGradingAI) and every
line as left by the operator, with where it came from. `scripts/export-grading-training-set.ts` exports
them as keypoints for training; see `docs/size-grading/carbongradingai-training.md`.

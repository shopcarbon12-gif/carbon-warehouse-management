# CarbonWMS-PC — Android shell for the WMS web app

Native Kotlin app that shows **https://wms.shopcarbon.com** (desktop/mobile view, unchanged) as an
Android app. The web app is the UI; this project only provides what a browser normally does.
Plan and audit: `Dropbox/elior perez/CarbonWMS-PC-Android-App-Plan-2026-08-25.html`.

**Fully separate from the Flutter handheld app** (`mobile/carbon_wms`): different package id
(`com.shopcarbon.wmspc`), signing key, and release folder. Both install side by side.

## Decisions baked in (owner, 2026-08-25)

| # | Decision | Where |
|---|---|---|
| Latest Android only | `minSdk 33`, `targetSdk 35` | `app/build.gradle.kts` |
| D1 free rotation | no orientation lock; landscape/tablet/DeX renders the desktop layout | manifest |
| D2 screen always on | `FLAG_KEEP_SCREEN_ON` while the app is open (toggle in Diagnostics) | `MainActivity.applyScreenPolicy` |
| D3 re-login on full close | session cookies cleared at process start and when the activity finishes | `App.onCreate`, `MainActivity.onDestroy` |
| D4 branding | id from `wmspc.shopcarbon.com` → `com.shopcarbon.wmspc`; icon = shopcarbon.com favicon in white on `#0c0f12` | `res/mipmap-*` |

## Biometric login (v1.1.0)

The app replaces the web `/login` page with a native sign-in sheet (`auth/LoginSheet.kt`), talking to the
unchanged `POST /api/auth/login`; the server's `wms_session` cookie is copied into the WebView.

- First sign-in: email + password, switch **"Use fingerprint / screen lock next time"** (on by default when
  the phone has a fingerprint or screen lock). Confirming once with the fingerprint saves the login.
- Every later open (cookies are cleared on full close — decision D3): the fingerprint prompt appears
  immediately; success → straight to the dashboard (or to the `?next=` page after a session expiry).
- Storage (`auth/SecureStore.kt`): password AES-256-GCM encrypted with an Android hardware-keystore key
  that only works right after a **Class-3 biometric (fingerprint) or the device PIN/pattern** succeeds
  (per-use auth). Re-enrolling fingerprints invalidates the key → the app asks for the password again.
  Samsung face unlock is Class 2 and is therefore not accepted by Android for this — fingerprint or PIN.
- Server rejects the saved password (changed in WMS) → saved login is dropped, normal form shown.
- "Use a different account" on the sheet, or Diagnostics → "Forget saved fingerprint login", removes it.
- Nothing changes on the server; the web login page still works in browsers exactly as before.

## What the shell handles (no web change needed)

- Cookie session persistence while open; HTTPS only; TLS errors never bypassed.
- File inputs → one sheet: **Files** (mime-filtered) + **Photo Picker** + **Camera** (any `image/*` or empty `accept`).
- `confirm / alert / prompt` → Material dialogs (alert has **Copy** for one-time passwords).
- `window.open` / `target=_blank` → pop-up sheet with Close/Print; off-origin links → system browser.
- `window.print()` → Android print dialog (injected shim + `PrintManager`).
- Downloads: server `Content-Disposition` → DownloadManager (cookie forwarded); `blob:` exports → Downloads via JS shim; APK → installer.
- ZPL to the LAN Zebras: mixed content allowed for `192.168.1.3` / `192.168.1.220` only (`res/xml/network_security_config.xml`).
  Native TCP-9100 bridge `window.CarbonWMSPC.printZpl(host, port, zpl)` is ready for the optional web hook (report §7.5).
- Offline page with auto-reconnect; edge-to-edge insets; predictive back; renderer-crash recovery.
- Engine gate: refuses to render on a WebView older than Chrome 111 and points to Play.
- OTA check against `/api/mobile/status?channel=pc` — **dormant** until the server has a `pc` channel (report §7.2).
- Diagnostics (long-press app icon → Diagnostics): server origin override (LAN dev box), WebView version, cookie state, logs, share.

## Build

```bash
bash apps/carbonwms-pc/scripts/build-release.sh      # → ~/CarbonWmsPcRelease/CarbonWMS-PC V<version>.apk
```
Uses the repo's Gradle caches (`.tools/gradle-user-home`), AGP 8.11.1, Kotlin 2.2.20, JDK 17+.
First run creates the release keystore (`keys/`, `key.properties`, gitignored) — back it up; OTA updates
require every future APK to be signed with the same key.

Debug build: `cd apps/carbonwms-pc && GRADLE_USER_HOME=../../.tools/gradle-user-home ./gradlew assembleDebug`
(installs as `com.shopcarbon.wmspc.debug`, WebView remote debugging enabled).

Version: bump `appVersionName` in `app/build.gradle.kts` (dotted only; `versionCode` is derived).

## Install / update

- First install: `adb install -r "~/CarbonWmsPcRelease/CarbonWMS-PC V1.0.0.apk"` or share the APK (Dropbox).
- Web changes (Studio prompt, pages, CSS, APIs) reach the app on the next page load — **no APK needed**.
- An APK is only needed when this shell changes.

## Optional server-side follow-ups (all isolated, see the report)

- §7.1 web manifest/icons · §7.2 `app_releases.channel` + Settings → Updates dropdown (activates OTA) ·
  §7.5 `window.CarbonWMSPC.printZpl` hook in the four print sites · `/.well-known/assetlinks.json` for App Links.

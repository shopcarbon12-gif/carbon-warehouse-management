# Carbon WMS (Flutter)

Rugged handheld client for Carbon WMS (Chainway / Zebra HAL stubs, tactical UI).

## Prerequisites

- [Flutter](https://docs.flutter.dev/get-started/install/windows) stable (repo copy: extract to `<repo>/.tools/flutter`, gitignored).
- [Android Studio](https://developer.android.com/studio) with Android SDK + SDK Platform matching the app (Flutter will prompt for components on first build).

## Android Studio

1. **File → Open** → select this folder (`mobile/carbon_wms`).
2. Install the **Flutter** and **Dart** plugins if prompted.
3. **Settings → Languages & Frameworks → Flutter** → set **Flutter SDK path** to your SDK (e.g. `<repo>\.tools\flutter`).
4. **local.properties** (under `android/`, gitignored) must define:
   - `sdk.dir=` path to the Android SDK (Android Studio: **Settings → Languages & Frameworks → Android SDK → Android SDK Location**).
   - `flutter.sdk=` path to the Flutter SDK (forward slashes are fine, e.g. `D:/path/to/flutter`).

## Release APK (CLI)

From this directory:

```powershell
.\scripts\build-apk.ps1
```

Output: `build/app/outputs/flutter-apk/app-release.apk`.

Release builds currently use the **debug signing** config so you can install without a keystore; for Play Store, add a release keystore in `android/app/build.gradle.kts`.

## Paths with spaces (Windows)

If the repo path contains spaces (e.g. `...\My project\...`), native-asset compilation may fail with `'D:\Projects\My' is not recognized`. Workaround (run **cmd as Administrator** once, adjust drive letters if needed):

```bat
mklink /J D:\cwm "D:\full\path\to\carbon-warehouse-management"
mklink /J D:\asdk "%LOCALAPPDATA%\Android Studio\sdk"
```

Then set `android/local.properties` to use **no-space** paths, for example:

```properties
sdk.dir=D:/asdk
flutter.sdk=D:/cwm/.tools/flutter
```

Open/build from `D:\cwm\mobile\carbon_wms` (or keep using the junction paths in `local.properties` only).

## D: only (no new build files on C:)

Keep the repo on **`D:`** (e.g. junction `D:\cwm` → your clone). The release script enforces that and redirects:

- `PUB_CACHE`, `GRADLE_USER_HOME` → `<repo>/.tools/…`
- `TEMP` / `TMP` and JVM `java.io.tmpdir` → `<repo>/.tools/tmp`

**Android Studio from the same policy:** in PowerShell, from `mobile/carbon_wms`:

```powershell
. .\scripts\env-d-drive.ps1
```

Then start Studio from that terminal (or run Gradle/Flutter there) so the same env applies.

Flutter SDK and Android SDK paths should also be on **`D:`** (e.g. `local.properties` with `D:/asdk` and `D:/cwm/.tools/flutter`).

## Other

- **C: drive full:** Some tools still write small prefs under `%APPDATA%` on `C:`; free space there if installs fail. APK/Gradle/Pub/temp for this project are kept under `<repo>/.tools/` via `build-apk.ps1` / `env-d-drive.ps1`.

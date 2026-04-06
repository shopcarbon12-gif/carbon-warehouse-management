# Carbon WMS (Flutter)

Rugged handheld client for Carbon WMS (Chainway / Zebra HAL stubs, tactical UI).

## Prerequisites

- [Flutter](https://docs.flutter.dev/get-started/install/windows) stable. **Recommended for this repo:** extract the Windows SDK zip to **`D:\flutter`** (see repo root `.vscode/settings.json`). Fallback: `<repo>/.tools/flutter` (gitignored) if you do not use `D:\flutter`.
- [Android Studio](https://developer.android.com/studio) with Android SDK + SDK Platform matching the app (Flutter will prompt for components on first build).

## Android Studio

1. **File → Open** → select this folder (`mobile/carbon_wms`).
2. Install the **Flutter** and **Dart** plugins if prompted.
3. **Settings → Languages & Frameworks → Flutter** → set **Flutter SDK path** to **`D:\flutter`** (or `<repo>\.tools\flutter` if you use the bundled copy). **Cursor** uses **`.vscode/settings.json`** → `dart.flutterSdkPath` (set to `D:/flutter` in this repo).
4. **local.properties** (under `android/`, gitignored) must define:
   - `sdk.dir=` path to the Android SDK (Android Studio: **Settings → Languages & Frameworks → Android SDK → Android SDK Location**).
   - `flutter.sdk=` path to the Flutter SDK (forward slashes are fine). Prefer **`D:/flutter`**; see **`android/local.properties.example`**.

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
flutter.sdk=D:/flutter
```

Open/build from `D:\cwm\mobile\carbon_wms` (or keep using the junction paths in `local.properties` only).

## Gradle

- **`gradle-*-src.zip`** (e.g. from Downloads) is **source code** only — the Android build needs a **binary** distribution (`-bin` or `-all`). The wrapper is set to use **`D:\Downloads\gradle-8.14-all.zip`** (on **D:**). To use another path or version, edit `distributionUrl` in `android/gradle/wrapper/gradle-wrapper.properties` (or use the official `https://services.gradle.org/distributions/gradle-8.14-all.zip` URL).

## D: only (no new build files on C:)

Keep the repo on **`D:`** (e.g. junction `D:\cwm` → your clone). **`build-apk.ps1`** enforces D: and dot-sources **`scripts/_carbon_wms_d_env.ps1`**, which redirects for **that process**:

- `PUB_CACHE`, `GRADLE_USER_HOME` → `<repo>/.tools/…` (or **`D:\CarbonWmsTooling\…`** if the **resolved repo path contains spaces** — required so native-asset hooks do not break)
- `TEMP` / `TMP` and JVM `java.io.tmpdir` → matching tmp root

**Important:** Cursor, IDE terminals, and a raw **`flutter`** / **`gradle`** command **do not** load `_carbon_wms_d_env.ps1` unless you dot-source it. To keep **every** Flutter/Gradle run off C:, run **once per Windows user** (no admin needed):

```powershell
cd D:\cwm\mobile\carbon_wms   # or your path to mobile/carbon_wms
.\scripts\install-user-build-env-on-d.ps1
```

That sets **User** environment variables to **`D:\CarbonWmsTooling\{pub-cache,gradle-user-home,tmp,xdg-cache,xdg-config}`**. **Fully quit and reopen Cursor** (or log off/on) so new shells pick them up. Verify:

```powershell
echo $env:TEMP; echo $env:PUB_CACHE; echo $env:GRADLE_USER_HOME
```

**Android Studio — same policy for one session:** from `mobile/carbon_wms`:

```powershell
. .\scripts\env-d-drive.ps1
```

Then start Studio from **that** terminal (or run Flutter/Gradle there).

Flutter SDK and Android SDK paths should also be on **`D:`** (e.g. `local.properties` with `D:/asdk` and `D:/flutter`; fallback `D:/cwm/.tools/flutter` if you use the repo-bundled SDK).

### Release APK when `flutter test` fails

Some setups hit native-asset / hook errors during **`flutter test`**. You can still produce a release APK:

```powershell
.\scripts\build-apk.ps1 -SkipTests
```

### Docker Desktop (local Windows)

To avoid large **C:** usage from Docker/WSL defaults, install Docker Desktop with data on **D:** (see [Docker Windows installer flags](https://docs.docker.com/desktop/setup/install/windows-install/#installer-flags)), e.g. `--installation-dir=D:\Docker\DockerDesktop` and `--wsl-default-data-root=D:\Docker\wsl`. This is **local dev only**; **Coolify** runs on your **Linux server**.

## Other

- **C: drive full:** Even with the above, some apps write under `%APPDATA%` on `C:`. Free space and use Storage settings if installs fail. **Agents:** see repo root **`AGENTS.md`** (Windows + D: section) and **`.cursor/rules/windows-carbonwms-dev-disk.mdc`**.

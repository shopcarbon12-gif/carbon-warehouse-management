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

## Other

- **C: drive full:** Flutter may fail writing `%APPDATA%\.flutter_settings`. Free space on `C:`, or move caches; the build script sets `PUB_CACHE` and `GRADLE_USER_HOME` under `<repo>/.tools/` to reduce pressure on `C:`.

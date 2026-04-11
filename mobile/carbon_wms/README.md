# Carbon WMS (Flutter)

Rugged handheld client for Carbon WMS (Chainway / Zebra HAL stubs, tactical UI).

> **Development is Linux-only.**  
> Windows is used exclusively as an SSH client to connect to the Linux machine via VS Code Remote SSH.  
> Do **not** run `flutter`, `gradle`, or any build command on Windows.

## Prerequisites (Linux)

- Flutter stable in `PATH` — on this machine at `/home/carbondev/development/flutter/bin`.
- Android SDK available on the Linux machine.
- Caches are kept inside the repo under `.tools/` (never in `~/.gradle` or system temp).

## Release APK (CLI)

From the **repo root** on Linux:

```bash
bash mobile/carbon_wms/scripts/build-release.sh
```

Output: `~/CarbonWmsRelease/CarbonWMS V<version>.apk`  
The script also SCPs the APK to `D:\CarbonWmsRelease\` on the Windows PC automatically.

## Gradle

Gradle configuration is in `android/gradle.properties`. Heap is capped at 3 GB and the daemon idle timeout is 5 minutes. Do not raise `-Xmx` without a clear reason.

The `distributionUrl` in `android/gradle/wrapper/gradle-wrapper.properties` points to a binary (`-all`) Gradle distribution. To change the version, edit that URL (use the official `https://services.gradle.org/distributions/` URL).

## `android/local.properties`

Copy `android/local.properties.example` to `android/local.properties` (gitignored) and set `sdk.dir` and `flutter.sdk` to the correct Linux paths.

## Other

- See repo root **`AGENTS.md`** for the canonical Linux build environment, Flutter SDK path, and APK output location.

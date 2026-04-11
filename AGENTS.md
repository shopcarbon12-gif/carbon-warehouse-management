<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

**Carbon WMS release APK (all agents):** After a release build, the canonical APK path is `~/CarbonWmsRelease/CarbonWMS V{pubspec version}.apk` (version from `mobile/carbon_wms/pubspec.yaml`). Build with:
```bash
bash mobile/carbon_wms/scripts/build-release.sh
```

---

## Linux build environment

All Flutter/Android builds run on **Linux Ubuntu**. Caches live under `.tools/` in the repo (Gradle, pub, tmp) — never in `~/.gradle` or system temp.

### Flutter SDK
Flutter is at `/home/carbondev/development/flutter/`. Ensure it is in `PATH`:
```bash
export PATH=”/home/carbondev/development/flutter/bin:$PATH”
```

### Building a release APK
```bash
bash mobile/carbon_wms/scripts/build-release.sh
```
Output: `~/CarbonWmsRelease/CarbonWMS V<version>.apk`

### Gradle memory
Configured in `mobile/carbon_wms/android/gradle.properties` — heap capped at 3G, daemon idle timeout 5 minutes. Do not raise `-Xmx` without a clear reason.

### Reference
- **`mobile/carbon_wms/README.md`** — Android SDK setup, `local.properties`.
- Production containers: **`.cursor/rules/nextjs-coolify-docker-hardening.mdc`**.

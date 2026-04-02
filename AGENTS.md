<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

**Carbon WMS release APK (all agents):** After a release build, the canonical path to report is `D:\CarbonWmsRelease\CarbonWMS V{pubspec version}.apk` (from `mobile/carbon_wms/pubspec.yaml` `version:`). See `.cursor/rules/carbonwms-apk-versioned-filename.mdc` and `flutter-apk-after-mobile-edit.mdc`.

---

## Windows + D: (all agents) — keep C: from filling; local Docker

This project’s **handheld** build expects tooling on **D:**. Follow this so Cursor/agents and raw `flutter`/`gradle` commands do not silently grow **C:** (`%TEMP%`, `%LOCALAPPDATA%\Pub\Cache`, `%USERPROFILE%\.gradle`).

### What we standardized (2026)

1. **One-time per Windows user — User environment variables on D:**  
   Run from `D:\cwm\mobile\carbon_wms` (or the real repo path):
   ```powershell
   .\scripts\install-user-build-env-on-d.ps1
   ```
   Creates **`D:\CarbonWmsTooling\{pub-cache,gradle-user-home,tmp,xdg-cache,xdg-config}`** and sets **User** `TEMP`, `TMP`, `TMPDIR`, `PUB_CACHE`, `GRADLE_USER_HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`. **Fully quit and reopen Cursor** (new terminals) so every Flutter/Gradle process picks this up — not only when `build-apk.ps1` runs.

2. **Per-session / scripted builds — `_carbon_wms_d_env.ps1`**  
   Dot-sourced by **`mobile/carbon_wms/scripts/build-apk.ps1`** and **`env-d-drive.ps1`**. Redirects caches to **`<repo>/.tools/...`** or, if the repo path **contains spaces**, to **`D:\CarbonWmsTooling\...`** (native-asset hooks break with spaced `PUB_CACHE`). **Raw `flutter` in a fresh terminal does not load this** — that is why **`install-user-build-env-on-d.ps1`** exists.

3. **Junction for paths with spaces**  
   Example: `mklink /J D:\cwm "D:\full\path\to\carbon-warehouse-management"`. Build and open **`D:\cwm\mobile\carbon_wms`**. Set **`android/local.properties`** to **no-space** `sdk.dir` / `flutter.sdk` (see **`mobile/carbon_wms/README.md`**). Explorer can show confusing free-space math when the repo is opened via two paths; optional long-term: clone **directly** under **`D:\`** without relying on a junction for “truth.”

4. **Docker Desktop on D: (local Windows)**  
   Install with CLI flags so binaries and WSL data stay on D:, e.g. `--installation-dir=D:\Docker\DockerDesktop` and `--wsl-default-data-root=D:\Docker\wsl` (see [Docker Windows install](https://docs.docker.com/desktop/setup/install/windows-install/#installer-flags)). **Coolify** still runs on the **Linux VPS**; this item is for **local** `docker compose` / Next parity — it avoids huge **C:** growth from default Docker/WSL placement.

5. **Release APK script**  
   **`.\scripts\build-apk.ps1`** enforces repo/SDK on D: and applies `_carbon_wms_d_env.ps1`. Use **`-SkipTests`** if **`flutter test`** fails (e.g. `objective_c` native-asset hooks) until the toolchain is fixed; still produces **`build/.../app-release.apk`** and copies to **`D:\CarbonWmsRelease`** per project rules.

### Reference

- **`mobile/carbon_wms/README.md`** — Android Studio, `local.properties`, Gradle, junctions.  
- **`.cursor/rules/windows-carbonwms-dev-disk.mdc`** — short duplicate of this section for Cursor (always applied).  
- Production containers: **`.cursor/rules/nextjs-coolify-docker-hardening.mdc`** (not the same as local Docker Desktop).

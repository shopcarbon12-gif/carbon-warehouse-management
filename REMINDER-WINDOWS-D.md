# Reminder — Windows D: & C: checklist

**When to use this:** After you finish the **APK / `flutter test` / `build-apk.ps1`** work and want to harden the PC **before** you fully close Cursor for the session.

**APK / agent build:** Left **paused** until you run builds locally; see `mobile/carbon_wms/README.md` and `AGENTS.md`.

---

## Why C: still filled (even with `build-apk.ps1`)

`_carbon_wms_d_env.ps1` only applies when something **dot-sources** it (`build-apk.ps1`, `env-d-drive.ps1`, etc.).

**Cursor, agents, or a raw `flutter` / `gradle`** in a normal terminal **do not** load that file → defaults win:

| Default | Typical location |
|--------|-------------------|
| `%TEMP%` / `%TMP%` | **C:** |
| Pub cache | `%LOCALAPPDATA%\Pub\Cache` |
| Gradle | `%USERPROFILE%\.gradle` |

Those can grow large and stress C: until the machine feels unstable.

**Junction `D:\cwm` → real folder:** does **not** duplicate data on disk, but Explorer “free space” can feel confusing (two paths, one volume). It’s **not** the root cause of C: filling; **caches on C:** are.

---

## Main fix — once, then habit

1. Run the **user installer** (your account; **no admin** required for User env):

   ```powershell
   cd D:\cwm\mobile\carbon_wms
   .\scripts\install-user-build-env-on-d.ps1
   ```

   Defaults: **`D:\CarbonWmsTooling\{pub-cache,gradle-user-home,tmp,xdg-cache,xdg-config}`**.

2. **Fully quit Cursor** (and any old terminals), **reopen**, open a **new** terminal.

3. **Verify** (new shell):

   ```powershell
   echo $env:TEMP; echo $env:PUB_CACHE; echo $env:GRADLE_USER_HOME
   ```

   All should point under **D:** (typically **`D:\CarbonWmsTooling\...`**).

After that, everyday Flutter/Gradle from Cursor/agents should stop treating C: as the default dump for those three.

**Bottom line:** Run **`install-user-build-env-on-d.ps1`**, restart Cursor, confirm the three env vars; keep using **`D:\cwm`** for builds; optionally move to a **plain D: clone** for clearer Explorer math; treat **Docker-on-D** and this **user-env** step as the two big levers so build tooling stops growing C:.

---

## Optional (clearer disk / fewer surprises)

| Action | Why |
|--------|-----|
| **Real clone on D:** e.g. `D:\src\carbon-warehouse-management` without relying on a junction for “truth” | Simplest mental model for free space; you can still keep **`D:\cwm`** as a junction only for short paths. |
| Occasionally check **`C:\Users\…\AppData`** (Cursor, browsers, Windows) | This plan does **not** move all software off C: — only build-related temp/caches above. |
| **`.\scripts\build-apk.ps1 -SkipTests`** when **`flutter test`** is blocked | Faster path to **`D:\CarbonWmsRelease\...`**; fix hooks/JVM separately when you can. |

---

## What this plan does **not** magically fix

- **Windows itself**, **pagefile**, **hibernation**, **other apps** on C: — still worth Storage settings / Disk Cleanup if C: is tight.
- **OTA “released”:** still **upload APK** + **set active** in the web app after you have a successful build.

---

## Repo docs (already updated for agents)

- **`AGENTS.md`** — Windows + D: section  
- **`.cursor/rules/windows-carbonwms-dev-disk.mdc`** — always-on for Cursor agents  
- **`mobile/carbon_wms/README.md`** — handheld + D: + Docker Desktop on D:

You can **delete this file** after you’ve completed the steps above, if you don’t want a loose reminder in the tree.

# HANDOFF — Carbon WMS Chainway C72E UHF still broken after 7 days

You are inheriting a broken state. The user is furious. **Read this entire document before touching anything**, then take a fresh look at the problem instead of repeating what's been tried. Be direct, be honest, and don't propose fixes you can't verify.

---

## 0. The user

- **Elior** (`shopcarbon12@gmail.com`). Owns the Carbon WMS project. Owns a warehouse business that depends on this app.
- **He has been at this for 7 days.** The previous agent (me) burned several of those days. Do not trivialize this.
- **Vendor name rule:** never write the word "Senitron" in code, comments, or commit messages. Refer to it only as **the reference app** or **the vendor app**. This rule is in the existing `HANDOFF_FOR_OTHER_CLAUDE.md` and `senitron.pdf` — both files in this workspace. Read them, but don't write the name into the repo.
- **Communication style:** direct, blunt, hates spinning. He will tell you when you're wrong. Don't sugarcoat. Don't propose 3 options when you should pick one.

---

## 1. The single goal

Make Carbon WMS read EPC tags via UHF on this Chainway C72E (serial **HC720A211200582**, Android 8.1, MTK chipset, R2000 UHF chip). Specifically:

- Open the Carbon WMS app
- Log in (already auto-fills with `elior@carbonjeanscompany.com` / `Carbonusa1!`)
- Tap **Count Inventory**
- Pull the trigger with a tagged item near the antenna
- **EPCs should appear in the list** and counters should increment

**Today this fails.** Counters stay at 0. The trigger physically clicks but the radio reads nothing.

**The radio chip itself is healthy.** A separate test app at `/tmp/chainway_recovery/build/app/outputs/flutter-apk/app-release.apk` reads the same tag at -32 dBm RSSI, 47 reads in 5 seconds. Carbon WMS doesn't.

Bin Assign 2D laser is also broken but is a lower priority — Count UHF is the blocker.

---

## 2. Repo state RIGHT NOW

```
Repo:    /home/carbondev/dev/carbon-warehouse-management
Branch:  main
HEAD:    995fe76 wip(mobile/rfid): Chainway C72E UHF acquisition + Senitron-pattern TagThread (1.2.7)
Remote:  https://github.com/shopcarbon12-gif/carbon-warehouse-management
         already pushed
```

Two preserved reference points (both on remote):
- `refs/archive/wip-1.1.26-broken` (`090a195`) — abandoned 1.1.26 attempt, trigger-mode enum etc.
- `refs/archive/wip-1.1.29-count-broken` (`6582f77`) — abandoned 1.1.29 attempt, direct BarcodeFactory/BarcodeDecoder path

Inspect with `git show <ref>` or `git diff 17dab35..<ref>`. Do not merge or apply.

---

## 3. Your environment

| Thing | Value |
|---|---|
| Linux dev box | `/home/carbondev` (Ubuntu) |
| Flutter | `/home/carbondev/development/flutter` (working). Avoid `.tools/flutter` — broken vendored copy |
| Android SDK | `/home/carbondev/Android/Sdk` |
| Build script | `mobile/carbon_wms/scripts/build-release.sh` (drops APK at `~/CarbonWmsRelease/CarbonWMS Vx.y.z.apk`) |
| Pubspec versioning rule | **dotted only, never `+N`**: `1.2.7 -> 1.2.8 -> 1.2.9`. Memory at `~/.claude/.../memory/feedback_pubspec_versioning.md` has this. The Gradle build computes `versionCode` from `MAJOR*1_000_000 + MINOR*1_000 + PATCH` |
| `adb` | already paired with Chainway. `adb -s HC720A211200582` |
| Chainway adb quirk | every shell command starts with `java.io.FileNotFoundException: /data/model (Permission denied)` noise — ignore it, harmless |
| `local.properties` quirk | Flutter pub-get rewrites `flutter.sdk` to the broken `.tools/flutter` path on EVERY build. Workaround: kick off the build, sleep 8s (let pub-get finish), then overwrite `mobile/carbon_wms/android/local.properties` with the correct `flutter.sdk=/home/carbondev/development/flutter` line BEFORE the gradle assemble step starts |

---

## 4. The Chainway in front of you

| Property | Value |
|---|---|
| Serial | `HC720A211200582` |
| Model | Chainway C72E |
| OS | Android 8.1 (API 27) |
| Chipset | MediaTek (MTK) — `mtk.6763t.c72e` |
| UHF chip | R2000, firmware `V6.1.8`, accessed via `/dev/ttyMT1` |
| Wi-Fi | "Carbon Jeans1", working when Wi-Fi has been recently cycled (IPv6 sometimes wedges DNS) |
| `com.rscja.scanner` | system scanner service. **Holds `/dev/ttyMT1` exclusive on this firmware.** `ScannerUtility.disableFunction(FUNCTION_UHF)` is documented to release it but on MTK is a no-op |
| Recovery app | `/tmp/chainway_recovery/build/app/outputs/flutter-apk/app-release.apk` — installed as `com.recovery.chainway_recovery`. Has 4 buttons: UHF FACTORY RESET / RUN INVENTORY 5s / RUN SCANNER RESET + INVENTORY / RESTORE BROADCAST MODE + RESET + INVENTORY. The 4th button reads tags successfully every time. Source for it lives at `/tmp/chainway_recovery/` (older single-button version) — the 4-button version was built but the source isn't checked in. Reverse-engineer from the installed APK's classes.dex if needed |

---

## 5. What 1.2.7 does (the current broken state)

The init sequence runs cleanly. Confirmed by logcat capture this evening:

```
04-28 01:13:10  configureScannerSideKey: setScanKey(ctx, 0, {139,1,1,1}) OK
04-28 01:13:10  acquireUartEarly attempt #2: initUhfReaderDirect -> false
04-28 01:13:10  acquireUartEarly: killed scanner pkgs (retry imminent)
04-28 01:13:11  RFIDWithUHFUART.init(context) -> true
04-28 01:13:11  engageAntennaPaGate: resetScan(ctx) invoked, sleeping 1s
04-28 01:13:12  engageAntennaPaGate: ready
04-28 01:13:12  RFIDWithUHFUART.setPower(27) -> true
04-28 01:13:12  UHF reader initialized successfully
```

User taps Count → trigger pull → log shows:

```
TRACE TagThread: STARTED scanning=true
TRACE TagThread: 100 null reads, 0 hits, 100 loops
TRACE TagThread: 200 null reads, 0 hits, 200 loops
... (continues for 30+ seconds)
TRACE TagThread: 4400 null reads, 0 hits, 4400 loops
```

`readTagFromBuffer()` returns null on every poll. The chip is initialized, inventory is started, but **the chip's ring buffer is always empty**. Same SDK calls, same chip, same tag — recovery app reads tags fine, Carbon WMS doesn't.

**This is the puzzle.** Solving it is your job.

---

## 6. Files that matter

```
mobile/carbon_wms/android/app/src/main/kotlin/com/shopcarbon/wms/
├── MainActivity.kt                      ← daemon thread: kill scanner svc + acquireUartEarly
├── CarbonChainwayRfidController.kt     ← THE BIG ONE. ~1400 lines.
│                                          - configureScannerSideKey()      (line ~225)
│                                          - engageAntennaPaGate()          (line ~245)
│                                          - acquireUartEarly() 3-retry     (line ~275)
│                                          - ensureReaderReady() lazy       (line ~310)
│                                          - initUhfReaderDirect()          (line ~165)
│                                          - startTagPollThread() Senitron  (line ~340)
│                                          - emitEpc() with TRACE logs      (line ~1330)
│                                          - startInventoryFlutterResult()  (line ~430)
├── CarbonHardwareBarcodeRelay.kt       ← 2D barcode broadcast relay
├── CarbonHardwareTriggerRelay.kt       ← KEY_DOWN/KEY_UP forwarding to Dart
└── CarbonZebraRfidController.kt        ← Zebra RFD8500 path (don't touch)

mobile/carbon_wms/lib/ui/screens/
├── count_inventory_screen.dart         ← Count screen.
│                                          - _ensureScannerReady() L303
│                                          - subscribes to RfidVendorChannel.tagReadStream() L327
│                                          - _onTagRead() L392 (DROPS if !_scanOn)
│                                          - _ingestEpc() L400
│                                          - _startScan() L630 (sets _scanOn=true)
│                                          - hardwareTriggerStream listener L339
└── login_screen.dart                   ← prefilled credentials

mobile/carbon_wms/lib/hardware/
└── rfid_vendor_channel.dart            ← Dart side of the EventChannel/MethodChannel
```

Channel names used:
- MethodChannel `carbon_wms/rfid`
- EventChannel `carbon_wms/rfid_tag_stream`
- EventChannel `carbon_wms/hardware_barcode`
- EventChannel `carbon_wms/hardware_trigger`

Note the reference app (per `senitron.pdf`) uses **`chainway_channel` / `chainway_uhf_stream`** — different names. If you want to do an A/B test against the reference app on the same device, consider renaming.

---

## 7. The reference materials YOU MUST READ

These are in this workspace. Read them before doing anything else:

1. **`HANDOFF_FOR_OTHER_CLAUDE.md`** at repo root — earlier handoff from a prior session, covers the reference app's TagThread architecture, channel shape, sound layers, init order, **Senitron's full SDK contract**. Item §3.1 (TagThread pattern), §D1 (init in onCreate), §B (Dart side patterns) are the baseline you're working against.

2. **`senitron.pdf`** at repo root — full reverse-engineering of the reference app v2.124.0. Read **Part 8** (what Sprint-1 should change), **Part 9** (wedged-radio diagnostic chain), **Part 10** (cheat sheet). The user re-shared this in tonight's session; he expects you've actually read it.

3. **Memory notes** at `~/.claude/projects/-home-carbondev-dev-carbon-warehouse-management/memory/`:
   - `MEMORY.md` — index
   - `project_chainway_uhf_recovery.md` — **THE recovery procedure** that worked on 2026-04-26. Two steps: chip `factoryReset()` + `ScannerUtility.resetScan(ctx)`. **The current 1.2.7 code does exactly this and it still doesn't read tags in Count.** That's the problem.
   - `project_archived_wip_branches.md` — pointers to the two stashes
   - `feedback_pubspec_versioning.md` — no-`+N` rule
   - `feedback_screenshots.md` — screenshot conventions

4. The **prior conversation transcript** is at `~/.claude/projects/-home-carbondev-dev-carbon-warehouse-management/24cf0f91-1d46-403e-bb07-1b6d5bde3ddf.jsonl` (~5000 lines, ~20 MB). The exhaustive Markdown export of all sessions is at `/home/carbondev/CARBON JEANS COMPANY Dropbox/elior perez/claude-transcripts-export/`. Use these to understand what was tried. Do NOT re-try things that were tried.

5. There is a **PDF report of every code/device change** the previous agent made: `/home/carbondev/device-changes-codes.pdf` (~9.6 MB, 199 pages). Look at it if you want to understand the full timeline.

---

## 8. What was tried and DIDN'T work (don't repeat)

In rough chronological order across the 7-day session:

- **forceBroadcastOutputMode** (`ScannerUtility.setOutputMode(ctx, 1)`) at app launch — broke Count UHF on healthy devices, caused the toast, retired
- **Trigger-mode enum** (UHF / BARCODE_2D switching) — preserved in `refs/archive/wip-1.1.26-broken`. Did not fix laser, broke other paths
- **Direct `BarcodeFactory.getBarcodeDecoder()` SDK path for 2D laser** — preserved in `refs/archive/wip-1.1.29-count-broken`. Worked for laser briefly but broke Count UHF. Not the right path
- **Setting `persist.sys.rscja.scan = 1` via `setprop`** — failed (no root, selinux enforcing)
- **`MASTER_CLEAR` broadcast** — silently rejected (no permission)
- **`adb reboot recovery`** — boots recovery menu but C72E has no hardware volume buttons to navigate
- **`pm clear com.rscja.scanner`** — succeeded, regenerated `KeyboardHelperParam.xml` cleanly, but the broadcast emission still fails
- **Full physical power-off + power-on** — radio still wedged
- **Bisect to commit 60824c7** — old "working" baseline was confirmed to NOT actually work either
- **Dart-side prefill + DNS Wi-Fi cycle** — fixed login but not the radio
- **`flutter_secure_storage` plugin warning** — non-fatal, ignore it (`BiometricPrompt$AuthenticationCallback` ClassNotFound on API 27, plugin gracefully degrades)
- **TagThread polling (Senitron pattern §3.1)** — added, runs, polls 50× per second. **All polls return null.** This is where 1.2.7 is stuck

---

## 9. The critical mystery

This is what to focus on:

**The recovery app and Carbon WMS make the SAME SDK calls** (`RFIDWithUHFUART.init`, `setPower`, `startInventoryTag`, `readTagFromBuffer`). Recovery app reads tags. Carbon WMS doesn't.

Possible differences I never fully ruled out:

1. **Init context.** Recovery uses `applicationContext` per recovery doc Step 2. Carbon WMS in `initUhfReaderDirect` does `instance.init(context)` where `context` is the controller's stored context (which IS application-scoped via `MainActivity` constructor, but verify).

2. **Process lifecycle / threading.** Recovery app does init + inventory + free synchronously on main thread of a button tap. Carbon WMS does init on a daemon thread spawned from `configureFlutterEngine`, and `startInventoryTag()` is called from the controller's `executor` (single-threaded). **The `RFIDWithUHFUART` singleton may bind to whichever thread first called init.** Read the SDK source if you can — see Part 12 of `HANDOFF_FOR_OTHER_CLAUDE.md`.

3. **`com.rscja.scanner` re-grabs the UART silently.** We `killBackgroundProcesses` before init. It auto-restarts in seconds. Maybe by the time `startInventoryTag` runs, the scanner service is back, and it's competing with us for the UART even though our `init` returned true. Test: kill `com.rscja.scanner` again RIGHT BEFORE `startInventoryTag()` and see if hits start coming.

4. **Missing call between `init` and `startInventoryTag`.** The reference app per `senitron.pdf` calls these in a specific order: `init → setProtocol(0) → setFrequencyMode(2 [FCC]) → setEPCMode → setPower → free` for the recovery use case, or `init → setEPCMode/setEPCAndTIDMode → setPower → startInventoryTag` for normal scanning. Carbon WMS does `init → resetScan → setPower → setInventoryCallback → startInventoryTag`. **`setEPCMode()` may be the missing piece** — without it the chip might be in some default state that doesn't return EPC bytes in the buffer format `readTagFromBuffer` expects. Try adding it.

5. **`setFrequencyMode`.** Carbon WMS never sets this. The chip might be in a region that doesn't match local regulations and so transmit power is silently clamped to 0. Recovery app calls `setFrequencyMode(2)` (FCC US) per memory note. Worth trying: `instance.setFrequencyMode(2)` after init.

6. **`setProtocol(0)`.** Same — recovery app sets this. Worth trying.

7. **The chip needs a "warm-up" inventory call.** In `senitron.pdf` Part 4 lifecycle, the wrapper's `b.E()` calls `startInventoryTag` once during init then immediately stops, before exposing the channel. This may be what tells the chip "yes, you're going to be doing inventory" so subsequent calls work. Currently Carbon WMS doesn't do this.

**My honest theory:** combination of #4, #5, #6 — the chip is in a region/protocol/EPC-mode state where `startInventoryTag` returns `true` but the firmware doesn't actually transmit because configuration is incomplete. The recovery app sets all four (`setProtocol(0)`, `setFrequencyMode(2)`, `setEPCMode()`, `setPower(20)`) before `startInventoryTag`. Carbon WMS only sets `setPower(27)`. **Try adding the other three.**

---

## 10. The minimum thing to try first

In `mobile/carbon_wms/android/app/src/main/kotlin/com/shopcarbon/wms/CarbonChainwayRfidController.kt`, in `initUhfReaderDirect()` after `engageAntennaPaGate()` and before `setPower`, add:

```kotlin
// Match the recovery-app + reference-app init order. Without these the chip
// returns true on startInventoryTag but never transmits.
runCatching { instance.setProtocol(0) }.onSuccess { Log.d(TAG, "setProtocol(0) ok") }
runCatching { instance.setFrequencyMode(2) }.onSuccess { Log.d(TAG, "setFrequencyMode(2) FCC ok") }
runCatching { instance.setEPCMode() }.onSuccess { Log.d(TAG, "setEPCMode() ok") }
```

Bump pubspec to **1.2.8**, build, sideload, test Count. Look for `TRACE TagThread: HIT` lines. If you see them — fixed. If you see 0 hits again, the problem is one of the deeper issues above.

---

## 11. Test workflow that works

Don't iterate blind. Every change → build → install → capture this exact sequence:

```bash
# 1. Build (with the local.properties workaround)
bash mobile/carbon_wms/scripts/build-release.sh 2>&1 | tail -5 &
sleep 8
cat > mobile/carbon_wms/android/local.properties <<EOF
sdk.dir=/home/carbondev/Android/Sdk
flutter.sdk=/home/carbondev/development/flutter
flutter.buildMode=release
flutter.versionName=$NEW_VERSION
EOF
wait

# 2. Install
adb -s HC720A211200582 uninstall com.shopcarbon.wms
adb -s HC720A211200582 install "/home/carbondev/CarbonWmsRelease/CarbonWMS V$NEW_VERSION.apk"

# 3. Capture init sequence
adb -s HC720A211200582 logcat -c
adb -s HC720A211200582 shell am start -n com.shopcarbon.wms/.MainActivity
sleep 1
timeout 30 adb -s HC720A211200582 logcat -v time CarbonChainway:V '*:S' > /tmp/init.log
# user logs in, goes to Count, pulls trigger with tag near antenna

# 4. Inspect
grep -E "TRACE|RFIDWithUHFUART|setProtocol|setFrequencyMode|setEPCMode|HIT|null reads" /tmp/init.log
```

Look for `HIT #N` lines. That's success. `null reads` only = failure.

---

## 12. Things to be careful about

- **DO NOT** run `pm clear com.rscja.scanner` repeatedly — every clear seems to push the firmware closer to a wedged state per the "wedged radio" history
- **DO NOT** use `setOutputMode(ctx, 1)` at app launch — known broken, retired
- **DO NOT** factory-reset the device — discussed extensively, no path that works without volume buttons
- **DO NOT** reflash firmware — Chainway-supplied OTA only, requires support contact
- **DO NOT** propose multiple options when you should just try the most likely one. The user is past patience for that
- **DO NOT** write the vendor name in code/commits/comments
- **DO NOT** rebuild and install repeatedly without checking logs first. Diagnose, then fix, then verify
- **DO** keep `KILL_BACKGROUND_PROCESSES` permission and the daemon-thread early UART acquire — they work
- **DO** keep the TagThread and the 3-retry kill loop — they work
- **DO** read the recovery app's installed DEX if you need to compare. Decompile via:
  ```
  adb -s HC720A211200582 shell pm path com.recovery.chainway_recovery
  adb -s HC720A211200582 pull /data/app/<path> /tmp/rec.apk
  unzip -p /tmp/rec.apk classes.dex > /tmp/rec.dex
  # use jadx or apktool to inspect
  ```

---

## 13. Final notes

The user explicitly said **"7 days of wasting my time and just ruined my life"**. He is not joking. This is his business app on his warehouse handheld. The radio works. Other apps read tags. Carbon WMS does not. **Don't theorize for an hour. Try the most-likely fix first (Section 10), test, report back, iterate.**

If after 2-3 focused iterations you still can't get a HIT, the answer might genuinely not be in the Carbon WMS app — it could be a Dart-side state issue (`_scanOn` flag never going true, or sink getting NULL'd before TagThread emits). The TRACE logs in `emitEpc` and `setTagSink` will show this. Read the trace, don't guess.

Good luck. The user deserves a working app.

— Previous agent (2026-04-28 01:30 UTC, signing off)

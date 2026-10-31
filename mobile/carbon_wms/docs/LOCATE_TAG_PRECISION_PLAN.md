# Locate Tag precision and operator workflow plan

Reviewed 2026-10-12 against local commit 3433c22; Flutter app version 1.2.162.

Delivery plan revised 2026-10-12 after review of Claude's feedback and the new Store Replenishment flow in local commit 352e1ff / app 1.2.163. The earlier code findings and test result remain attributed to the initial review. Only this planning document was updated.

The user confirmed a Zebra reader with the phone attached and dissatisfaction with precision, responsiveness, directions, and the screen/audio experience. This is a code and SDK review plus an implementation plan. No physical reader measurements were taken during this review. This review changed no application code, radio configuration, production data, or APK.

**Recommendation**

Ship small correctness and feedback fixes first. Start a bounded Zebra native-Locate experiment on day one. Keep a simple signal bar, compare the fixed screen with native Locate, and make the larger guided-sweep interface conditional on demonstrated benefit. The four-stage design below is an optional later design, not the minimum release scope.

Separate two goals: **find this exact EPC** for tag-specific work, and **find any eligible unit of this SKU/variant** for stock picking. Precision means completing the selected task correctly and quickly with few misleading cues. Signal strength and phone orientation alone do not establish a reliable centimeter position or geometric bearing in metal racks.

**0. Revised order: early fixes, day-one experiment, then an evidence-based decision**

**First release: improve the existing screen.** Remove feet/inches/contact claims and the looping radar; replace it with a plainly labeled signal bar. Stop substituting old or invented RSSI when strength is missing. Track real-observation age, clear stale direction immediately when evidence becomes invalid, and make the applied-power display reactive. Clear bearing/trend history across power changes. Keep unvalidated directional arrows off by default in this release; fixing stale hints alone does not fix the existing RSSI-to-yaw timing error.

For the signal bar, use valid recent RSSI within a fixed applied setting, with stable smoothing and a separate target-detected state. If showing a normalized number, label it “Signal,” never closeness/distance/confidence, and reset its comparison baseline after a setting change. Merely relabeling the existing rung-weighted percentage is insufficient. A native locationing value should instead be labeled relative proximity; do not mix the scales. Retain familiar upward visual feedback without pretending that either scale is a physical measurement.

**Power correction is a small native change, not just an added await.** The existing Android method returns when work is queued, and the adapter also uses unawaited calls. Add an acknowledged locate operation inside the existing Zebra controller's serialized executor, returning actual completion/readback, failure, and radio state. Preserve existing general-purpose method behavior for other screens initially. Exclude queued old-power samples before promoting a narrower setting. If reliable application/freshness cannot be verified within the first patch, ship a verified fixed-power search mode with automatic narrowing disabled and an explicit limitation. Do not delay all screen corrections for a broad reader-manager rewrite.

**Exact EPC matching needs transport evidence.** The suffix workaround's comment describes historical padding/shifting, but this review has no raw capture proving the current failure's cause. Native Zebra currently passes getTagID() through trim/uppercase; the shared Dart parser strips nonhex characters and pads odd lengths. Capture bounded raw SDK output, channel payload, parsed EPC, and the known stored target on the actual reader. Correct only demonstrated framing/formatting errors without discarding identifier bits. Then enable full canonical EPC equality, with fixtures for known tags, malformed input, and different prefixes sharing the same suffix. If input cannot be reconstructed unambiguously, report an identity/reader-format error instead of accepting a suffix or silently presenting endless zero signal. This verification gates the exact-match change; it does not justify preserving ambiguous matching indefinitely.

**Day-one native-Locate spike.** Use the existing bundled SDK to build a diagnostic toggle/test screen with start/stop, exact target, capability check, relative output, freshness, and proper cleanup. Roughly one engineering day is a prototype target assuming immediate device access; successful SDK calls are not field validation. Start this alongside the first patch where staffing permits. Do not introduce a four-stage UI or rewrite shared scanning to run the experiment.

**Small screening comparison.** Use ten representative hidden placements and one search operator, comparing old screen, fixed screen, and native Locate. Have another person hide/re-hide tags where possible, use equivalent placements, and rotate method order to reduce memory bias. Include separate absent-target and disconnect/restore checks. Record correct retrieval, elapsed time, failures, false cues, and operator preference. This selects promising work; it does not support a general accuracy or reliability claim.

**Decision gate.** If native Locate plus the simple screen works best, ship that for exact-tag locating after focused regression/field checks. If controlled custom measurements are better, continue with them. Prototype guided sweeps only for a demonstrated remaining search problem, and retain them only if held-out tasks improve time/reliability or usability without accuracy regressions. Plan any-eligible-unit picking as a separate workflow so it does not depend on directional sweeps winning.

**Before rollout.** Keep Count, Encode, Status Change, Cloud Geiger, and Store Replenishment regression checks mandatory for any shared radio change. Even a clear winner in ten placements needs a broader pilot with another operator, hard placements, and lifecycle checks before general release. Scale up to the full trial described below when results are close, directional/calibration claims are introduced, or pilot results vary. A small screening win does not waive release testing.

**1. Findings in the existing implementation**

References below are relative to mobile/carbon_wms unless otherwise stated. Line numbers refer to the reviewed revision.

| Priority | Finding and evidence | Operator impact | Planned correction |
| --- | --- | --- | --- |
| P0 | _setRung updates the logical power index before the hardware operation completes; _engineTick can then use the prior peak with the new rung in the same tick (lib/ui/screens/locate_tag_screen.dart:583, 950–971). | The percentage can rise without evidence that the target was heard at the lower power. | Separate requested configuration from applied configuration and require fresh observations before promoting search range. |
| P0 | Power success returns when work is queued: android/.../MainActivity.kt:370–376; lib/hardware/zebra_scanner.dart:38–39 uses an unawaited power call. Native Zebra applies asynchronously and logs failures (CarbonZebraRfidController.kt:510, 1195). | A requested range can be displayed as if it were a measured range. The fixed 400 ms settle assumption is not tied to actual completion. | Acknowledge completion and effective power; handle failure, buffer drainage, and inventory restart as session states. |
| P0 | Direction and distance use _lastNormRssi = peak, where peak is raw RSSI. Bearing bins persist across changing power (locate_tag_screen.dart:962–966). | Changes in transmit power can look like changes in direction or movement. | Compare only observations from the same applied configuration. Reset evidence on changes. Do not assume a simple power correction works through saturation. |
| P0 | The rolling 250 ms RSSI peak is paired with the latest phone yaw on each engine tick (locate_tag_screen.dart:933–966). RfidTagRead has no sample timestamp; motion reports discard the sensor timestamp. | A strong sample from an earlier aim can be assigned to a later angle, potentially in multiple angular bins. | Timestamp observations and motion natively; align their times and bound uncertainty. Count each actual observation once. |
| P0 | Invalid/missing RSSI is replaced with the last value or -65 (locate_tag_screen.dart:813–819). | Repeated tag detections without strength can sustain invented strength and influence narrowing. | Track target presence separately from valid signal evidence. Show “Target detected; strength unavailable.” |
| P1 | Distance calibration conflicts with the repository's own data. test/locate_proximity_test.dart:8–18 records tag B at 3 ft with -33 dBm; lib/hardware/locate_bearing.dart:247–282 interprets -33 as “ON THE TAG” / “UNDER 12 IN.” | The user can be told the item is inches away when the cited measurement was three feet away. | Remove feet/inches/contact claims from the operator flow pending independent validation. |
| P1 | The ladder bands and distance hints are based on two garment tags using an RFD8500 and Motorola phone (lib/hardware/locate_proximity.dart:6–36). | Results cannot be assumed to generalize to other tags, orientations, racks, or readers. | Build measured reader/tag/environment profiles and validate on held-out tags. |
| P1 | _matchesTarget accepts the last 16 hex characters as a fallback (locate_tag_screen.dart:845). Hardware filtering and session results are ignored by _armRadio (:614). | If hardware filtering is ineffective, different full EPCs with a common suffix can influence the locator. | Capture the actual transport path, correct only demonstrated framing errors, require exact canonical EPC, and report configuration failures. |
| P1 | _lastTargetReadAt is refreshed by ticks while a buffered peak remains, rather than recording the observation's age (:982). Direction messages have a 1.5 s dwell even for signal loss (:1163). | “Still hot” and stale direction can outlast the evidence. | Use observation time; clear unsafe guidance immediately on loss/reconfiguration and debounce only ordinary wording changes. |
| P1 | _RungBar receives a plain rungDbm; its proximity listenable is not observed (locate_tag_screen.dart:1455, 1472). Rung changes do not call setState. | The displayed power/range can remain stale until an unrelated rebuild. | Publish one immutable locate view state with current stage, applied settings, quality, and freshness. |
| P1 | The sweeping radar is driven by a repeating animation, not a measured tag angle (locate_tag_screen.dart:1899 onward). | The visual suggests spatial knowledge that it does not represent. | Replace it with a simple signal bar/history first; add measured sweep coverage and broad sectors only if the later experiment succeeds. |
| P2 | Attached-phone yaw is useful, but the sensor stream lacks source, quality, and freshness; the native axis fallback changes when the pose becomes nearly vertical (CarbonMotionRelay.kt:101, 126–169). | Even an attached phone can provide unreliable guidance when tilted or sensor data is stale. | Validate the mount axis and expose full pose/quality. Decline directional guidance for ambiguous poses. |

Existing strengths to preserve: target hardware prefiltering on Zebra, S0 requests, native read batching, trigger debouncing, signal/UI decoupling through notifiers, a real inventory-health indicator, and explicit radio cleanup. These should be consolidated and tested rather than discarded.

**2. Optional guided operator journey, after the comparison gate**

These stages describe the richer exact-EPC workflow if it earns its additional interaction cost. The first patch and native-Locate trial retain a simpler screen. Stock picking follows the separate any-eligible-unit workflow in section 8a.

**Find area.** Open on the product photo, name, color, size, serial/EPC suffix, and recorded bin. Show a timestamped last RFID sighting only if the source is a genuine RF event. Otherwise label the value “Last recorded activity.” Start scanning at a verified search setting supported by the connected reader. Distinguish “Reader disconnected,” “Preparing reader,” “Searching; target not detected,” and “Target detected.” Use neutral wording when a target is absent; a missed read does not prove an empty shelf.

**Sweep.** Once detected, ask the operator to stand in one place and sweep slowly left–right. Keep applied transmit power constant during the comparison. Show sweep coverage and strongest repeatable sector, with an instruction such as “Strongest signal to your left.” Request a second pass before committing to a sector. If the evidence is inconsistent, display “Direction unclear — move sideways and scan again.” Moving to a new position starts a new sweep; do not carry the old geometry forward. Start with broad left/center/right sectors, not exact degree arrows.

**Narrow.** After the operator reaches the indicated rack/section, offer “Narrow search.” Hold a stable pose while probing a lower supported power. Display “Adjusting range” during actual configuration and collection. Accept the narrower range only after repeated, fresh target observations at that setting. If it fails, restore the last successful setting and show “Search widened.” Compare neighboring sections and shelf levels at the same setting and similar stand-off. Shelf-level guidance is a deliberate operator sweep, not an inferred vertical coordinate.

**Confirm item for exact-EPC work.** At the smallest stable search range, ask the operator to separate the candidate from the surrounding garments and recheck. The current Carbon hang-tag template encodes safeSku in its printed barcode (repository lib/utils/zpl-carbon-tag.ts:419); serial is in the RFID write (:424). The OLA template also uses the SKU. Do not require a serialized printed barcode as the normal workflow. A UPC/SKU scan verifies the product variant only. Use physical isolation, repeated exact-EPC reads, and explicit operator confirmation; record that verification method. If a future or alternative label has a unique printed serial/EPC, it can provide an optional stronger check. If isolation is impossible, report “Target nearby; item not isolated.” Never turn 100% signal into an automatic “Found,” and do not force exact-target isolation on a task that accepts any eligible unit.

After confirmation, offer the existing permitted item actions, with radio ownership transferred and restored correctly. Confirmation alone must not silently change inventory status, bin, or Shopify availability.

**3. Screen and feedback design**

Illustrative layout; item and location text are placeholders:

    [Photo]  Product name
             Black · Medium     Serial …123456
    Recorded bin: A-03-02
    Last RFID sighting: 2 hours ago [only with RF provenance]

    FIND AREA     SWEEP     NARROW     CONFIRM

                    SWEEP LEFT–RIGHT
              Keep your feet in one position

              [measured sweep coverage arc]
              [broad strongest signal sector]

              Signal stable · Repeat sweep
              [Signal strength bar — stable setting]
              [short signal history strip]

    [Pause]             [Narrow search]
    [Sound / vibration] [Details]

Use large, high-contrast instructions and controls usable with one hand. Keep the signal bar prominent in both the simple and richer interfaces. Keep EPC details, raw dBm, reads/sec, power indices, firmware, and debug counters under Details. Provide a compact layout for small screens and large text sizes. The richer layout above is conditional; its measured sweep arc supplements the bar only when useful. No looping sweep cone or arbitrary distance percentage.

Keep the physical trigger as the main scan/pause control; the screen button uses the same serialized command path. Show “Paused” clearly and stop live feedback. Any retained history must be visibly historical. A press-and-hold option can follow only after down/up behavior is validated on the exact device.

Audio should answer one question: is the target evidence getting stronger at the current setting? Use a steady, interpretable pulse, initially about 1–6 pulses/second as a tunable prototype range. Keep volume user-controlled rather than changing volume, cadence, and UI state together. Reconfiguration gets a distinct brief cue or silence, not a fake “colder” sound. Pause/loss stops the hot cadence. Offer vibration on meaningful transitions, plus a silent visual mode. Use a unique confirmation sound only after verification. Validate feedback latency and comfort with operators.

**4. Fix the radio contract before tuning the estimator**

Keep changes bounded to Locate first. Add the acknowledged operation within the existing native Zebra controller and retain a single radio owner; do not introduce a competing driver or refactor Count/Encode/Status Change to enable the experiment. Only if subsequent work requires it, consolidate a locate-session owner across Flutter and native Android to serialize start, stop, filter, power, mode, and restoration. Native inventory and native locationing are mutually exclusive modes. A connected-reader capability profile selects the correct adapter. Shared API changes require regression checks regardless of the apparent size of the patch.

On session start:

1. Capture reader model, serial, firmware, SDK version, region/profile, supported power values, locationing support, and current scan settings.
2. Snapshot settings to restore: power, filtering, singulation/session, trigger behavior, beep policy, relevant DPO state, and 2D ownership.
3. Validate the full target EPC. Keep the current 96-bit application scope unless another length is explicitly supported end to end. Invalid input must never silently clear a filter and report success.
4. Configure the selected mode and verify outcomes. Query DPO; if it affects controlled trials, change it only where supported and tested, then restore it at exit.
5. Announce active scanning only after actual start confirmation. A failed filter can either block the precision workflow or enter a clearly identified exact-EPC software-filter fallback with appropriate degraded confidence.

A configuration response should include sessionId, configGeneration, requestedPower, appliedPower/index, completion time, result/error, and actual radio state. Capability/readback gaps remain explicit unknowns. Deduplicate by confirmed applied state, not merely the last requested value. Retain native power-table units/indices without assuming an integer dBm request was applied exactly.

During a change, stop or transition safely, drain/exclude old reports, apply and read back where supported, then restart. Increment the configuration generation and accept only fresh data belonging to the new generation. A generation alone does not prove a queued SDK report was newly measured; reader timestamps or a characterized flush/quiet period are also required. Handle timeout/retry explicitly. The meter must not claim that the target moved during this operation.

On pause, disconnect, screen exit, backgrounding, and action navigation, stop the correct operation, invalidate evidence, and restore ownership/settings in sequence. Reconnect creates a new session generation and verifies configuration again. Preserve region restrictions and supported settings.

**5. Make observations usable for measurement**

Extend the read model and bridge with exact EPC, raw RSSI/validity, native monotonic receipt time, reader observation time if supported, session/config generation, effective power, reader identity, antenna ID if present, report aggregation count/window, and optional native relative-location value. Preserve missing values as missing. Phase/channel can be captured for experiments if available, but they are not a prerequisite or a promised ranging method.

Extend motion events with native monotonic sensor time, sensor type, quaternion or equivalent pose, projected antenna direction, quality, and valid-pose status. Confirm phone-to-reader alignment during setup using a short left/right check; account for the actual mount and phone tilt. Android's game rotation vector is appropriate for short relative rotations, but it can drift and is not absolute north. [Android sensor documentation](https://developer.android.com/develop/sensors-and-location/sensors/sensors_position).

Match RF observations to motion at measurement time where possible, otherwise use a measured receipt-time latency model with uncertainty. Do not treat SDK peak RSSI reports as instantaneous samples until their aggregation behavior is characterized. A proposed 100 ms maximum pairing uncertainty is an initial engineering budget, to be adjusted from measurements. If timing cannot support an angle, use stop-and-hold sector comparisons so antenna pose remains stable through the report delay.

Calculate signal features only within a stable applied configuration: median or trimmed statistics, upper percentile where useful, spread, fresh detection coverage in time windows, and time since a real observation. Validate robust summaries against held-out captures; do not assume the strongest reflection is the true direct path. Keep target-presence evidence, signal quality, and directional confidence separate. A missing RSSI event proves detection, not proximity.

**6. Select the proximity engine experimentally**

The bundled Zebra API3_LIB-release-2.0.2.82.aar exposes isTagLocationingSupported, TagLocationing.Perform/Stop, isContainsLocationInfo, and LocationInfo.getRelativeDistance. The current screen uses filtered inventory instead. Zebra documents the locationing output as a relative 0–100 value, not a distance in feet/meters or a direction. [Zebra Locate tutorial](https://techdocs.zebra.com/dcs/rfid/android/2-0-5-275/tutorials/locate/).

Run the same hidden-tag tasks with three candidates: current app as baseline, native Zebra locationing, and corrected filtered inventory. Inspect capability support on the user's exact reader/firmware. Choose the method with the best correct-item completion time, failure rate, stability, and latency, not the smoothest displayed percentage. Native locationing is an option to validate, not an assumed upgrade. Do not assume its internal power behavior makes it directly comparable with custom fixed-power sweep data.

If a hybrid wins, use explicit sequential modes: a validated native approach mode, followed by controlled filtered-inventory sweeps/narrowing. Clear evidence at each mode transition. Keep the first release simple if mode switching produces no measured benefit.

**7. Guided sweep and narrowing rules**

For a sweep, collect a contiguous arc at a fixed position, applied power, and reasonably stable pitch. Begin with a 60–120 degree instructed sweep, then repeat in the opposite direction. Use broad angular sectors whose statistics include real independent time coverage. Reject sectors supported by one outlier, very old samples, or uncertain RF/motion pairing. Compare the best sector with runner-up sectors and require repeatability across passes. Suggested prototype criteria are at least three usable observation windows per candidate sector and two passes agreeing within a broad 20–30 degree sector; these are tuning starting points, not accuracy claims.

Do not call a peak-to-median threshold an anti-reflection guarantee: a strong reflection can satisfy it. Penalize competing peaks and nonrepeatable sweeps. In an ambiguous aisle, ask for a different vantage point and start fresh. Phone IMU alone does not reliably measure translation; have the operator explicitly rescan after moving, while using motion heuristics only as additional invalidation hints. If the field becomes saturated or directionless near the item, transition to section-by-section narrowing instead of insisting on wider sweeps.

For narrowing, discover supported power steps at runtime. Test coarse steps first, then finer steps around the stable detection boundary if the reader supports them. Investigate levels below the current 5 dBm floor only when exposed and verified by the actual device. Do not promise zero-dBm operation based on a different reader's documentation.

At each candidate setting: wait for confirmed application and fresh reports; collect several timed detection windows (initial prototype: 3 of 4 windows of roughly 250 ms); classify repeatability; and retain the previous stable setting on failure. Determine final window lengths from actual report rates and native aggregation. A missing event counts as negative evidence only while inventory is confirmed active and configuration is stable. Hold the narrow setting during neighboring-item comparisons. Request an explicit wider search when necessary and make that transition visible. Lowest readable power is a relative isolation cue; orientation, tag sensitivity, and rack geometry prevent treating it as a universal distance ruler.

**8. Product, bin, and history integration**

Introduce one typed LocateTarget context for every entry point: exact EPC/serial, SKU, name, color, size, image, recorded location/bin, provenance and timestamps, and entry-point identifiers. Existing catalog calls already expose EPC/bin/last_seen_at (lib/network/wms_api_client.dart:1052); the item-detail server result supplies product image, location/bin, and source device/antenna (repository lib/server/rfid-tracker.ts:62–131).

Cloud Geiger currently omits bin when opening Locate (lib/ui/screens/cloud_geiger_screen.dart:441); other entry points provide different subsets. Load cached context immediately and enrich asynchronously. Network failure must not block an already known EPC search. Validate stale/moved/sold status and warn with useful context while keeping authorized workflows available.

Treat current recorded bin as a search starting point, not live positioning. Existing source_device/source_antenna fields identify provenance and must not automatically be labeled the last live reader sighting. Existing items.last_seen_at is also updated by non-RF workflows; use a typed RF history event for “last RFID sighting,” otherwise “last recorded activity.” Add a small typed endpoint/history extension only where needed. Do not invent a warehouse map or current tag coordinates from a bin string.

**8a. Separate mode: find any eligible unit for Store Replenishment**

Current evidence: Store Replenishment opens CatalogEpcListScreen with liveOnly=true (lib/ui/screens/store_replenishment_screen.dart:406). The list keeps in-stock items and opens LocateTagScreen with one selected EPC (lib/ui/screens/inventory_catalog_screen.dart:970, 1139). Catalog EPC lookup already restricts candidates by exact customSkuId and active WMS location (repository lib/queries/catalog.ts:148). The user should be able to tap “Find any available unit” directly from the replenishment line.

Proposed first version:

1. Pass search intent, exact customSkuId/variant, active location, line ID, requested quantity, and eligible full EPC set. Refresh in-stock eligibility and show the age of cached data. Color and size must match; a shared style, matrix, or EPC suffix is insufficient.
2. Discover candidates using inventory and exact set membership. Use hardware filtering only where its capability and mask semantics are validated. A SKU/prefix filter alone cannot enforce live status or arbitrary EPC-set membership. Do not assume native Locate accepts a set just because it accepts one target or documents masking.
3. Keep observations separately for each EPC. Select a repeatably detected candidate and hold that choice with hysteresis; offer “Try another unit.” Clear signal history when changing candidates so readings from different tags cannot masquerade as movement. Hand a selected exact EPC to the winning single-tag engine if useful. The operator need not select its serial in advance.
4. Show the variant/photo and recorded bin, then let the operator physically pull any currently eligible matching unit. SKU barcode scanning can verify the variant without requiring exact-target isolation for ordinary manual replenishment. RFID presence alone is not proof an item was pulled.
5. Return to the existing explicit whole-line completion action in the first version. Show requested quantity clearly; do not auto-check it after one tag read. Current persistence is one Boolean/row per sale line, with no picked quantity or EPC list (repository lib/server/store-replenishment.ts:177; scripts/migrations/0109_store_replenishment_picks.sql:5).

Boundaries: current eligibility covers the entire WMS location, not specifically its backroom. Define source-zone/bin exclusions before promising backroom-only selection; missing bin data should remain unknown. The current replenishment flow has no per-EPC reservation/assignment, and completion verifies that some stock exists rather than that specific units were pulled. Keep its existing manual semantics in the first version and make no claim of duplicate-proof or quantity-verified picking.

A later quantity-verified workflow needs requested/picked/remaining counts, distinct physically verified EPCs, live eligibility revalidation, and atomic assignment/deduplication across lines and operators. It is a separate backend scope, not a free side effect of locating any nearby tag. Do not change stock status or invent reservations without designing that behavior explicitly.

Cached candidates can support offline searching, but eligibility is then provisional. Current failed replenishment saves revert and show “Not saved”; keep that behavior or implement an explicit unsynced queue with reconciliation. Never show a failed/offline server save as completed.

Evaluate this mode separately using time to retrieve any eligible unit, physically pulled eligible units per minute, whole-line completion time for quantities above one, wrong-variant/ineligible picks, and duplicate-unit counting if serialized quantity tracking is introduced. Do not impose the exact-tag retrieval KPI or a forced serial-isolation step on a task that accepts any eligible unit.

**9. Calibration and acceptance testing**

For the first comparison, capture the minimum necessary evidence: known target, reader/firmware, method, actual settings where verified, timestamps, raw observations, operator actions, completion, and failures. Expand Tag Test for custom calibration only if that work proceeds. It currently exports aggregated peak/mean/min/counts and phone identity, with requested power rather than confirmed effective power. Its capture flow can choose the strongest EPC when multiple tags answer; require explicit confirmation of the known target before collecting calibration data. The expanded capture includes raw timestamped observations, motion, reader/firmware, applied power/config, tag/inlay family, garment material, placement/orientation, bin/rack context, known test distance, and action markers. Retain data by test/session with bounded buffers; keep uploads optional and offline-safe and operator/session identifiers pseudonymous.

Start with the ten-placement screening pass in section 0. If building a custom calibration model, use 20–30 representative target tags: hanging and folded garments, dense adjacent tags, plastic and metal racks, shelf levels, front/reverse/edge orientations, and strong-reflection locations. Include stationary tests, slow/fast sweeps, walking away, target removal, no-target cases, low battery, delayed/batched/null RSSI, and disconnect/reconnect. Separate calibration tags/placements from evaluation tags/placements.

For the extended comparison, use at least 30 hidden target placements, three operators, and randomized method order. This larger trial is justified by close screening results, custom directional/calibration claims, or inconsistent pilot outcomes; it is not a prerequisite to making the basic screen truthful. Re-hide or use equivalent placements to reduce memory bias. Include target-absent trials, record failures and timeouts, and stratify easy/dense/reflective cases. Measure both total search time and the final isolation portion. Neither screening nor this trial establishes a rare-error rate; expand evaluation if uncertainty is large. Apply the following performance targets to an adequately sampled rollout evaluation, not to a ten-task demonstration; functional correctness and shared-screen regression requirements apply to every release.

| Metric | Definition | Proposed initial release gate |
| --- | --- | --- |
| Correct locate time | Start command to verified correct serialized item, including configuration time | Median at least 30% lower than current baseline; p90 not worse. Report failures alongside times. |
| Completion within 60 s | Correctly verified targets / target-present trials | At least 90% in the agreed pilot layout; separately report dense/reflective cases. Revisit the threshold if the baseline/layout shows it is inappropriate. |
| Final isolation time | Observer-marked start of individual garment/item checks to verification, using the same marker in both app versions | Median at least 30% lower than baseline. Track Narrow-stage duration separately for diagnostics. |
| Wrong-item confirmation | Confirmations of the wrong serialized item | Zero observed in pilot; exact-ID matching is mandatory. Zero observed is not proof of zero population risk. |
| False “Found” without verification | App success when only a strong signal exists | Zero by state-machine design and negative tests. |
| Displayed sector usefulness | Sector cues matching the hidden target's true sector | Target at least 90% for emitted cues; also report abstention rate so silence cannot hide poor coverage. |
| Feedback latency | Fresh valid native observation to visible/audio update | p95 under 250 ms. Measure trigger-to-first-read separately. |
| Stale live guidance | Latest real valid evidence to hot/direction removal after genuine loss | Initial target within 500–750 ms at normal read rates; determine from measured report cadence. |
| Configuration truth | Displayed applied power/state versus confirmed native state | 100% agreement in integration scenarios; no precision promotion during pending/failed application. |
| Session reliability | Start/stop/reconnect/navigation cycles requiring app restart | Zero failures in at least 100 controlled cycles per supported reader profile. |
| Operator usability | Correct task completion after brief instruction plus ease rating | At least 4/5 median ease score and no critical ambiguous state. |

Instrument locate_started, reader_ready, target_first_seen, sweep_completed/rejected, range_change_started/applied/failed, narrow_entered, signal_lost/reacquired, confirmation_attempted, item_confirmed with method, locate_abandoned, and reader_error as those features are introduced. Include search intent, model/firmware/profile/engine and bounded session timestamps. Define start-to-ready, ready-to-detection, area-search, and final-isolation durations separately to locate bottlenecks. Any-unit mode additionally records candidate changes, eligibility age, requested quantity, and manual line completion without conflating detected with physically picked.

Business measures are items found per labor hour, picking exceptions, wrong-item picks, and orders delayed by missing stock. Labor minutes saved per day = locate tasks/day × mean seconds saved/task ÷ 60.

**10. Implementation sequence and estimated effort**

Estimates are engineering planning ranges, not delivery promises. They assume access to the user's attached-phone Zebra and warehouse test time. Parallel day-one tracks require another engineer; with one engineer they are sequential. Field scheduling is separate from coding time.

| Stage | Work | Output / exit gate | Initial effort estimate |
| --- | --- | --- | --- |
| A | Day-one native-Locate prototype, reader capabilities, minimum trace capture | Exact-tag test mode works and restores prior settings; no claim yet that it is better | About 1 engineering day if hardware is available |
| B1 | Existing-screen fixes: remove invented RSSI/distance/radar, show signal bar, expire hints, disable unvalidated arrows, make displayed settings reactive | Small UI patch ready for the identity/power release gate; no four-stage UX required | 1–2 engineering days plus focused checks |
| B2 | Locate-specific acknowledged power application and old-report exclusion; capture/repair EPC framing and enforce exact identity | Verified power/data contract and known-tag matching; otherwise use fixed-power fallback and diagnose unresolved identity errors | Allow 1–3 additional days, re-estimate if firmware/transport behavior is unclear |
| C | Ten-placement screening, current vs fixed vs native, plus fault/restore checks | Provisional engine choice, observed limitations, decision whether sweep prototype is justified | Half to one warehouse test day, depending on placement difficulty |
| D | Any-eligible-unit discovery from replenishment, stable candidate selection, existing explicit line completion | Faster SKU/variant picking without requiring manual serial selection | Provisional 2–4 engineering days; no new quantity/reservation backend included |
| E, conditional | Guided-sweep proof of concept with synchronized/fixed-power evidence | Keep only if held-out tasks add value over selected simple mode | Scope after C; stop if timing or warehouse evidence is inadequate |
| F | Shared-screen regression checks, broader operator pilot, device-level feature flag and rollback | Release gates pass for exact-tag and any-unit modes independently | 1–2 engineering days plus 3–5 working days of observation; expand trials according to risk |

Package the first fixes as their own versioned release APK after their focused and shared-screen checks, rather than waiting for later stages. That first APK requires B2's verified identity/power guarantees, or the verified fixed-power and explicit identity-error fallback from section 0; B1 alone must not ship a new signal bar driven by ambiguous suffix matches or unconfirmed settings. The 1–2-day estimate applies to the small screen corrections, not a guaranteed end-to-end power/EPC repair on untested firmware. The native prototype can be a clearly marked internal test build. Stage D can proceed independently after the measurement contract is adequate; it does not depend on guided sweeps winning.

The previous 12–20 engineering-day estimate described the full custom rebuild and field-validation scope. It is no longer a prerequisite or a fixed commitment: choose only the additional work supported by the screening results. Serialized quantity picking, reservations, and new source-zone rules require separate estimates. If the reader cannot isolate dense garments even at its lowest verified usable power, test a compatible near-field accessory/reader or a changed physical verification workflow separately before buying hardware.

Ship new engines behind a per-device/profile feature flag. Prefer the corrected simple screen as fallback; retain the original build only for controlled comparison/rollback, with its known measurement limitations recorded. An algorithm, profile, or firmware change must be versioned in telemetry and evaluated before expanding rollout.

**11. Suggested code boundaries and regression checks**

For the first patch, keep edits small and locate-specific, including the additive acknowledged operation in the existing native controller. If the larger workflow proceeds, introduce lib/locate/ modules for LocateTarget, LocateObservation, ReaderCapabilities, LocateSession, LocateEngine, SweepEstimator, LocateViewState, and LocateTelemetry as needed (names illustrative), with explicit exact-EPC versus eligible-set intent. Do not make extracting every module a prerequisite for correcting the screen. Keep widgets focused on rendering and commands. Extend existing adapters rather than adding a second radio-control system. Potential edit targets are locate_tag_screen.dart, locate_proximity.dart, locate_bearing.dart, rfid_tag_read.dart, rfid_vendor_channel.dart, rfid_manager.dart, zebra_scanner.dart, MainActivity.kt, CarbonZebraRfidController.kt, CarbonMotionRelay.kt, tag_test_screen.dart, and locate/replenishment entry points. A targeted server change may add RF provenance; it is not required for local locating.

Add meaningful replay/state tests: old-power reads after a change, out-of-order/batched samples, null RSSI bursts, shared-suffix wrong EPC, failed filter/power writes, saturation, conflicting angular peaks, report latency, sensor dropout/pose changes, invalid signal age, and pause/reconnect/navigation races. Assert operator behavior and evidence rules, not a copied formula. Test that rejected cues never appear as exact location claims. Verify active scan status against native state and restore the previous radio settings before another screen takes ownership.

Exercise Count, Encode, Status Change, Cloud Geiger, and Store Replenishment after exiting Locate; include entering Locate from an already configured reader. These checks apply to the quick patch too. Test audio suppression restoration, 2D reopening, power/session/filter restoration, screen backgrounding, repeated trigger taps, offline context, and small-screen layout. For any-unit mode, test wrong variants, ineligible/stale candidates, candidate switches, multi-unit lines, repeat reads of one EPC, two operators, and failed completion saves. Run targeted automated checks and field validation before bash mobile/carbon_wms/scripts/build-release.sh. A released Flutter APK belongs at ~/CarbonWmsRelease/CarbonWMS V{pubspec version}.apk. No APK is built for this planning revision.

Secondary compatibility: the Chainway code intentionally caches power changes until reinitialization and documents a C72E firmware wedge (CarbonChainwayRfidController.kt:163–203), with a 5–23 dBm clamp. These are code observations, not a live diagnosis of any C72E. Keep this work scoped to Zebra, preserve existing Chainway behavior, and require device-specific live evidence before changing or claiming improved behavior there.

**12. Review validation and evidence limits**

Ran the existing tests with the repository Flutter SDK/cache conventions:

    flutter test --no-pub test/locate_proximity_test.dart test/locate_bearing_test.dart

Result: **39 tests passed**. These validate existing proximity formulas and synthetic bearing behavior. They do not validate the UI/radio timing issues above or establish warehouse accuracy. The discrepancy between the distance function and the recorded three-foot sample is visible directly in the source data and formula. All hardware improvements and numerical acceptance targets in this plan still require validation on the actual attached-phone Zebra setup.

Manufacturer references supporting implementation options: [Zebra native Locate](https://techdocs.zebra.com/dcs/rfid/android/2-0-5-275/tutorials/locate/), [Zebra reader capabilities](https://techdocs.zebra.com/dcs/rfid/android/4-0-0-9/tutorials/rfiddevguide/), and [Android rotation sensors](https://developer.android.com/develop/sensors-and-location/sensors/sensors_position). Public documentation covers SDK versions beyond the locally bundled SDK; available symbols were also inspected in the bundled SDK, and actual reader support remains a runtime check.

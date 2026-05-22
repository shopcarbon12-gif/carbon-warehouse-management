# Handoff — POS reader (192.168.1.69) still not scanning at 17 dBm

**Status at handoff:** POS reader is in a wedged state. Bridge reachable, chip responds to query commands, but produces **0 tag reads** at any power, any driver, after the full software-reset stack runs every 60 seconds.

**Operator constraint:** POS antenna is configured at **17 dBm** and must stay there. PoE cycle of the chassis was explicitly refused. Operator wants automated recovery to fix it, not manual intervention.

---

## All supervisor / agent / watchdog code shipped today (2026-05-21)

Order is chronological. All five commits are in `apps/carbon-cdm/src/monsoon-supervisor.ts`. They are deployed to the warehouse VM at `192.168.1.219:/opt/carbon-cdm/dist/monsoon-supervisor.js` via `scp` + `sudo install` + `sudo systemctl restart carbon-cdm-agent`. Web side is unaffected.

### `605624a` — post-bridge-reset quiet window

Added field `slot.bridgeResetAt: number` (ms timestamp). `tryBridgeReset` stamps it. The on-exit respawn timer (both stream + console drivers) now extends `finalDelay` to `bridgeResetAt + POST_BRIDGE_RESET_QUIET_MS - now` so the next spawn waits for the bridge + chip's UART to fully reboot.

- Constant: `POST_BRIDGE_RESET_QUIET_MS = 18_000`.
- Also clears `slot.sweepPowerOverrideArg = null` and resets `slot.bridgeResetAt = 0` when the quiet window applies, so the post-reset spawn uses operator's configured power, not a stale sweep step.

### `84c15cc` — Antenna Test wakes paused readers

Added field `testWakeReaders: Set<string>` mirroring `activeScanSessionReaders`.

- In `enterTestMode`: if no slot exists for the reader, look it up in `lastBundle`, add to `testWakeReaders`, call `this.reconcile(this.lastBundle)` to create the slot, then proceed normally.
- In `leaveTestMode`: drop the reader from `testWakeReaders` and re-reconcile after a 2 s delay so the test child's graceful SIGTERM completes before the slot tears down.
- In `reconcile`'s `desiredById` filter: added `this.testWakeReaders.has(r.id)` as a third wake condition (alongside `!effective_paused` and `activeScanSessionReaders.has`).

Before this fix, Antenna Test on a paused reader silently no-op'd — the WMS UI showed Ready/green but the agent logged `enterTestMode for unknown reader` and read nothing.

### `402f0ba` — Low-power slots skip sweep, go direct to bridge-reset cycle

For readers configured below `SWEEP_POWERS[last] = 30` dBm (POS at 17), auto-sweep was harmful: it walked `330 → 30` and none of those match the operator's deliberate low setting. Each spawn at the wrong power gave 0 records, leaving the slot wedged forever.

New behaviour in the watchdog tick:
- Compute `configuredPower = avgPower(spec)` and `skipSweepLowPower = configuredPower < min sweep power`.
- If `skipSweepLowPower`, gate sweep entry off entirely.
- Add a second branch that, when `skipSweepLowPower && !bytesSinceSpawn && SWEEP_RETRY_COOLDOWN_MS elapsed since last sweep attempt && same since last bridgeResetAt`, fires `tryBridgeReset` directly (no sweep state) and `killSlotChildHard(slot)` so the on-exit respawn picks up the post-bridge-reset quiet window from `605624a`.

Log line to grep: `supervisor: low-power slot stuck — direct bridge reset (no sweep)`.

### `c866c6c` — `tryBridgeReset` also runs `MonsoonReader --stop` first

Inside `tryBridgeReset`, BEFORE the `wiznet-cli --reset` call, spawn:
```
sudo timeout --kill-after=1s 6s /opt/legacy-rfid/MonsoonReader --stop \
  --monsoon_host <ip> --monsoon_cport <port>
```

The legacy `MonsoonReader --stop` finds any ghost TCP session the bridge is still holding from a previously SIGKILL'd supervisor child and releases it. Without this, the chip stays busy serving the dead session and ignores new spawns.

Verified live: manual `MonsoonReader --stop` printed `A MonsoonReader instance connected to 192.168.1.69 is already running. MonsoonReader shutdown`.

Log line: `supervisor: tryBridgeReset — MonsoonReader --stop exited`.

### `f8b3ac7` — Chip-level reset via `new_monsoonreader --reset`

Also inside `tryBridgeReset`, concurrent with `MonsoonReader --stop`, spawn:
```
sudo timeout --kill-after=1s 8s /opt/legacy-rfid/new_monsoonreader \
  <ip> <port> --reset
```

This issues an R2000 chip reset opcode that clears internal Gen2 state (selection target, session, inventory queue) that survives both `--stop` and `wiznet-cli --reset`.

Verified manually: `new_monsoonreader 192.168.1.69 10002 --reset` returns `Reset command issued`. `--query` returns `Reply 020600f0` (chip alive).

Log line: `supervisor: tryBridgeReset — new_monsoonreader --reset (chip-level) exited`.

---

## Full automated recovery chain when a reader stays silent

For every reader, every 60 seconds of silence at configured power, the supervisor now runs:

1. `MonsoonReader --stop` — releases ghost bridge sessions
2. `new_monsoonreader --reset` — chip R2000 Gen2 state reset
3. `wiznet-cli --reset` — bridge reboot
4. 18 s `POST_BRIDGE_RESET_QUIET_MS` window — UART drain
5. Spawn at operator's configured power

For readers configured below 30 dBm, sweep mode is skipped entirely (was the wedge cause on POS @ 17 dBm).

Throttled by `SWEEP_RETRY_COOLDOWN_MS = 60_000` so it can't thrash.

Wedge-level escalation already in code (pre-existing):
- Level 2 (≥ 3 attempts in 5 min) → deep recovery
- Level 3 (≥ 6 attempts in 10 min) → `needs_hardware_service` pushed via heartbeat → UI shows red

---

## POS reader state at handoff

**The chip at 192.168.1.69 produces 0 tag reads despite every software intervention.**

Evidence (all gathered today 2026-05-21):
- TCP `nc -z 192.168.1.69 10002` → succeeds
- `wiznet-cli -d` → bridge `0008DC5956A8` reachable, NVRAM correct (server mode, 10002, 115200 8N1)
- `new_monsoonreader 192.168.1.69 10002 --query` → returns `Reply 020600f0` (chip alive)
- `MonsoonReader --stop` → "MonsoonReader shutdown" (works)
- `new_monsoonreader --reset` → "Reset command issued" (works)
- `wiznet-cli --reset` → "Device reset was successful" (works)
- `new_monsoonreader --stream --power 170 --verbose` for 8 s → 0 reads (was hitting `Connection reset by peer` then `Interrupted system call` post-reset)
- `new_monsoonreader --console --power 170` for 8 s → 0 reads
- Stream driver swapped via DB (`devices.config.monsoon_driver = 'stream'`) → no change

**Earlier today same chip at same 17 dBm read 62 + 82 tags successfully (≈14:12).** Wedge happened during operator's antenna-test sweeps from the WMS UI that killed/respawned the chip every 1.5 s for ~minute (sessions `5a8fa069…`, `537202c7…`, `58ae7145…`, `b0c100d9…`, `cae7b21c…`). Chip has been silent since.

**Operator's POS power setting is 17 dBm.** They reverted my earlier diagnostic bump to 33 dBm immediately. They have 4 tags positioned to be read at 17 dBm and want it to work as it did earlier today.

---

## What I haven't tried (potential next steps)

Operator refused PoE cycle. Operator does not want manual one-shot fixes — they want it to auto-recover.

Software options not yet tried:
1. **One-shot diagnostic probe at higher power inside the recovery chain.** After the full reset stack, supervisor could spawn ONE child at e.g. 25 dBm for ~5 s as a "is the chip producing reads at any power" probe, then revert to configured 17 dBm. If the probe sees reads, the chip is alive and 17 dBm is the issue. If the probe sees 0, the chip is hardware-wedged.
2. **Force-reload the cdm_agent ↔ reader association.** Detach POS from the agent in WMS, reattach. Resets all server-side state.
3. **Send raw R2000 opcodes** via the binary's lower-level CLI (if any exists; not found in `--help` strings dump).
4. **`new_monsoonreader --reset --stop` repeatedly with delays** — observed sometimes a 2nd or 3rd reset un-sticks chips other reset-once didn't.

Hardware options operator has refused:
- PoE cycle the chassis
- Physical inspection of antenna cable
- Reader swap

---

## Files / processes

- Source: `apps/carbon-cdm/src/monsoon-supervisor.ts` (HEAD = `f8b3ac7`)
- Built dist: `apps/carbon-cdm/dist/monsoon-supervisor.js`
- VM path: `192.168.1.219:/opt/carbon-cdm/dist/monsoon-supervisor.js` (owned `root:root`, mode 644)
- Service: `carbon-cdm-agent.service` on `192.168.1.219`
- Deploy command: `scp dist/monsoon-supervisor.js shopcarbon@192.168.1.219:/tmp/sup.js && ssh shopcarbon@192.168.1.219 'sudo install -m 644 -o root -g root /tmp/sup.js /opt/carbon-cdm/dist/monsoon-supervisor.js && sudo systemctl restart carbon-cdm-agent'`
- Coolify webhook (WMS web side, not agent): commit `605624a` deployed earlier, agent commits are agent-only
- Logs: `sudo journalctl -u carbon-cdm-agent -f`
- POS reader: id `cbbeffbd-6ba7-4965-beba-80e206327b9e`, name `POS`, IP `192.168.1.69`, port `10002`, MAC `0008DC5956A8`, agent UUID `3cc77dd5-2fe1-42b5-9420-e132940ccdb6` (orlando-cdm), location `001`

## Web-side commits today (not relevant to POS reader but on `main`)

- `6002e92` — sidebar foldable + hamburger + pin button (localStorage `wms.sidebar.pinned`)
- `6fe332e` — overview/locations Shelf Map mobile fix (horizontal scroll)
- `6ed7c7c` — Shelf Map Add-item flow sweeps all (UPC, color) EPCs via `sourceBinId: "any"`

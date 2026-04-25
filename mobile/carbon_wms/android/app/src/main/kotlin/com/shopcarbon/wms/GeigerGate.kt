package com.shopcarbon.wms

import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Process-wide gate for the Geiger / Locate screen.
 *
 * When [enabled] is true, the native per-tag beep (fired from inside the
 * Chainway / Zebra emit paths) only sounds for reads whose EPC matches
 * [target]. When false, every read beeps as before — Count, Bin Assign,
 * Search & Encode all keep the unfiltered per-read beep.
 *
 * Accessed from the SDK's own polling thread so reads use atomic primitives
 * — no lock, no allocation per read. The MethodChannel handler in
 * [MainActivity] flips these on screen entry / exit.
 */
internal object GeigerGate {
  private val enabledFlag = AtomicBoolean(false)
  private val targetEpc = AtomicReference<String?>(null)

  fun setEnabled(value: Boolean) { enabledFlag.set(value) }

  fun setTarget(epc: String?) {
    val normalized = epc?.trim()?.uppercase()?.takeIf { it.isNotEmpty() }
    targetEpc.set(normalized)
  }

  /** Returns true if the per-tag beep should fire for [epc]. */
  fun shouldBeep(epc: String): Boolean {
    if (!enabledFlag.get()) return true                // not in geiger mode → original behavior
    val want = targetEpc.get() ?: return false         // geiger on but no target → silent
    return epc.equals(want, ignoreCase = true)
  }
}

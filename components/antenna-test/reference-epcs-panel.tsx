"use client";

/**
 * Reference-EPC pass/fail tracker for the Antenna Test page.
 *
 * Operator places known tags in known bins (e.g. bottom-far corner of the
 * worst-case section), pastes their EPCs here, then runs a sweep. The panel
 * shows seen/missing in real time — that's the engineering pass/fail signal
 * for "did this antenna placement actually cover the bins I care about?"
 *
 * The list is scoped per (reader, antenna) and persisted in localStorage
 * so it survives page reloads and re-pickings without operator effort.
 * Pure client-side — no server schema needed.
 */

import { useMemo, useState } from "react";
import type { AntennaTestRow } from "./use-antenna-test-stream";

const EPC_HEX_RE = /^[0-9A-F]{24}$/;

type StoredState = { list: string[]; pasteText: string };

function storageKey(
  readerId: string | null | undefined,
  antennaId: string | null | undefined,
): string | null {
  if (!readerId || !antennaId) return null;
  return `antenna-test:reference-epcs:${readerId}:${antennaId}`;
}

function loadStored(key: string | null): StoredState {
  if (!key || typeof window === "undefined") return { list: [], pasteText: "" };
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return { list: [], pasteText: "" };
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    return {
      list: Array.isArray(parsed.list) ? parsed.list : [],
      pasteText: typeof parsed.pasteText === "string" ? parsed.pasteText : "",
    };
  } catch {
    return { list: [], pasteText: "" };
  }
}

export type ReferenceEpcsState = {
  /** Cleaned, uppercase, deduped 24-char hex EPCs. */
  list: string[];
  /** Live-edited textarea contents — committed via parseAndSave(). */
  pasteText: string;
  setPasteText: (s: string) => void;
  /** Validate, dedupe, uppercase, persist. */
  parseAndSave: () => void;
  /** Wipe both list and pasteText. */
  clear: () => void;
};

/**
 * Per-(reader, antenna) reference-EPC list, persisted in localStorage.
 * Returns the cleaned list plus textarea handlers for the panel below.
 */
export function useReferenceEpcs(
  readerId: string | null | undefined,
  antennaId: string | null | undefined,
): ReferenceEpcsState {
  const key = storageKey(readerId, antennaId);
  // Lazy initial load. Subsequent key changes (operator picks a different
  // antenna) are detected by tracking the previous key in state — this is
  // React's recommended pattern for "reset state when a prop changes"
  // without bouncing through an effect, which would cause an extra render
  // and trip the set-state-in-effect lint rule.
  const [list, setList] = useState<string[]>(() => loadStored(key).list);
  const [pasteText, setPasteText] = useState<string>(
    () => loadStored(key).pasteText,
  );
  const [prevKey, setPrevKey] = useState<string | null>(key);
  if (prevKey !== key) {
    setPrevKey(key);
    const next = loadStored(key);
    setList(next.list);
    setPasteText(next.pasteText);
  }

  const persist = (next: StoredState) => {
    if (!key || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* localStorage quota / private mode — silently drop, list is in memory */
    }
  };

  const parseAndSave = () => {
    const tokens = pasteText
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const seen = new Set<string>();
    const next: string[] = [];
    for (const t of tokens) {
      const u = t.toUpperCase();
      if (!EPC_HEX_RE.test(u)) continue;
      if (seen.has(u)) continue;
      seen.add(u);
      next.push(u);
    }
    setList(next);
    persist({ list: next, pasteText });
  };

  const clear = () => {
    setList([]);
    setPasteText("");
    persist({ list: [], pasteText: "" });
  };

  return { list, pasteText, setPasteText, parseAndSave, clear };
}

export type ReferenceSighting = {
  epc: string;
  row: AntennaTestRow | null;
};

export function buildSightings(
  list: string[],
  rows: Map<string, AntennaTestRow>,
): { seen: number; total: number; items: ReferenceSighting[] } {
  let seen = 0;
  const items: ReferenceSighting[] = [];
  for (const epc of list) {
    const row = rows.get(epc) ?? null;
    if (row) seen += 1;
    items.push({ epc, row });
  }
  return { seen, total: list.length, items };
}

export function ReferenceEpcsPanel(props: {
  state: ReferenceEpcsState;
  rows: Map<string, AntennaTestRow>;
  isLive: boolean;
  hasAntennaPicked: boolean;
}) {
  const { list, pasteText, setPasteText, parseAndSave, clear } = props.state;
  const [expanded, setExpanded] = useState(true);

  const sightings = useMemo(
    () => buildSightings(list, props.rows),
    [list, props.rows],
  );

  const allSeen = sightings.total > 0 && sightings.seen === sightings.total;
  const missingCount = sightings.total - sightings.seen;

  // Color the headline number: green when 100% seen, red when any missing,
  // muted when no list yet. Mirrors the bin-coverage pass/fail story from
  // the test methodology.
  const passColor =
    sightings.total === 0
      ? "var(--wms-muted)"
      : allSeen
        ? "#0f9c4f"
        : "#b53d3d";

  return (
    <section className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-card)] p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--wms-fg)]">
            Reference EPCs · pass/fail tracker
          </h3>
          <p className="mt-0.5 font-mono text-[10px] leading-snug text-[var(--wms-muted)]">
            Stick a known tag in each bin you care about (worst-case first:
            bottom-shelf, far-end-of-section, against the back wall). Paste
            those EPCs below — the panel shows live which ones came up and
            which didn&apos;t, so you have a hard pass/fail for this antenna&apos;s
            coverage. Saved per (reader, antenna) on this browser.
          </p>
        </div>
        {sightings.total > 0 && (
          <div className="flex items-center gap-1.5 font-mono text-[12px]">
            <span style={{ color: passColor, fontWeight: 700 }}>
              {sightings.seen}/{sightings.total}
            </span>
            <span className="text-[var(--wms-muted)]">seen</span>
            {missingCount > 0 && (
              <>
                <span className="text-[var(--wms-muted)]">·</span>
                <span style={{ color: "#b53d3d", fontWeight: 600 }}>
                  {missingCount} missing
                </span>
              </>
            )}
            {allSeen && (
              <span className="ml-1 inline-block rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                ✓ pass
              </span>
            )}
          </div>
        )}
      </header>

      {!props.hasAntennaPicked ? (
        <p className="mt-3 font-mono text-[11px] text-[var(--wms-muted)]">
          Pick an antenna to start managing its reference list.
        </p>
      ) : (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
            <textarea
              rows={3}
              spellCheck={false}
              placeholder={
                "F0A0B30E4F9C748000013171\nF0A0B30E4F9BCC8000001C75\n…paste 24-char hex EPCs, any separator (newline, comma, space)"
              }
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              className="w-full resize-y rounded border border-[var(--wms-border)] bg-[var(--wms-bg)] px-3 py-2 font-mono text-[11px]"
            />
            <div className="flex flex-row gap-2 sm:flex-col sm:items-stretch">
              <button
                onClick={parseAndSave}
                disabled={!pasteText.trim()}
                title="Parse the textarea, drop anything that isn't a 24-char hex EPC, dedupe, save."
                className="rounded bg-[var(--wms-accent)] px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
              >
                Parse &amp; save list
              </button>
              {list.length > 0 && (
                <button
                  onClick={clear}
                  title="Wipe the saved list for this antenna."
                  className="rounded border border-[var(--wms-border)] bg-[var(--wms-bg)] px-3 py-2 text-xs hover:bg-[var(--wms-card)]"
                >
                  Clear list
                </button>
              )}
            </div>
          </div>

          {list.length === 0 ? (
            <p className="mt-3 font-mono text-[11px] text-[var(--wms-muted)]">
              No reference list yet. Paste EPCs above and click{" "}
              <strong>Parse &amp; save</strong>.
            </p>
          ) : (
            <div className="mt-3">
              <button
                onClick={() => setExpanded((v) => !v)}
                className="font-mono text-[10px] uppercase tracking-wide text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
              >
                {expanded ? "▾" : "▸"} {list.length} reference tag
                {list.length === 1 ? "" : "s"}
              </button>
              {expanded && (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-xs font-mono uppercase tracking-wide text-[var(--wms-muted)]">
                      <tr>
                        <th className="px-2 py-1 text-left">EPC</th>
                        <th className="px-2 py-1 text-left">Status</th>
                        <th className="px-2 py-1 text-right">Best RSSI</th>
                        <th className="px-2 py-1 text-right">First-read pwr</th>
                        <th className="px-2 py-1 text-right">Reads</th>
                        <th className="px-2 py-1 text-left">Last seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sightings.items.map(({ epc, row }) => (
                        <tr
                          key={epc}
                          className="border-t border-[var(--wms-border)]"
                        >
                          <td className="px-2 py-1 font-mono text-[11px]">
                            {epc}
                          </td>
                          <td className="px-2 py-1">
                            {row ? (
                              <span
                                className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white"
                                style={{ background: "#0f9c4f" }}
                              >
                                ✓ seen
                              </span>
                            ) : (
                              <span
                                className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white"
                                style={{ background: "#b53d3d" }}
                              >
                                ✗ missing
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-1 text-right font-mono text-[11px]">
                            {row ? `${row.bestRssiDbm.toFixed(1)} dBm` : "—"}
                          </td>
                          <td className="px-2 py-1 text-right font-mono text-[11px]">
                            {row && row.firstReadPowerArg !== null
                              ? `${(row.firstReadPowerArg / 10).toFixed(1)} dBm`
                              : "—"}
                          </td>
                          <td className="px-2 py-1 text-right font-mono text-[11px]">
                            {row ? row.reads : 0}
                          </td>
                          <td className="px-2 py-1 font-mono text-[10px] text-[var(--wms-muted)]">
                            {row
                              ? new Date(row.lastSeenMs).toLocaleTimeString()
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

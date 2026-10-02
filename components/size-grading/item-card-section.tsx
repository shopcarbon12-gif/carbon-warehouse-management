"use client";

/**
 * The Size Grading block on an item card.
 *
 * Shows the measurements the Size Grading page saved against this exact size,
 * every one of them in a text box. A measurement read off a photo is a good
 * first draft and nothing more — a creased hem, a sleeve folded under, a tape
 * that was a few pixels off, and the number is wrong in a way only the person
 * holding the garment can see. So the numbers are editable and saving an edit
 * is one button.
 *
 * Saving appends rather than overwrites, matching the Size Grading page: the
 * photo reading and the operator's correction are both kept, and the card shows
 * the most recent.
 *
 * Centimetres are stored; inches are shown beside each box as you type, because
 * the floor works in inches and the spec sheets are in centimetres.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";

import { GARMENT_LABELS, POMS_FOR, POM_LABEL, type GarmentType, type PomKey } from "@/lib/size-grading/garment";

type Measurement = {
  id: string;
  garment_type: string;
  points_cm: Record<string, number>;
  measured_at: string;
  note: string | null;
};

const isGarment = (v: string): v is GarmentType => v in GARMENT_LABELS;

export function SizeGradingSection({ customSkuId, editable }: { customSkuId: string; editable: boolean }) {
  const [loading, setLoading] = useState(true);
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  /** Text, not numbers: a half-typed "5." must survive a keystroke. */
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        const r = await fetch(`/api/inventory/size-grading?customSkuId=${customSkuId}`);
        const j = (await r.json().catch(() => ({}))) as { measurement?: Measurement | null };
        if (!alive) return;
        const m = j.measurement ?? null;
        setMeasurement(m);
        setDraft(
          m ? Object.fromEntries(Object.entries(m.points_cm).map(([k, v]) => [k, String(v)])) : {},
        );
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [customSkuId]);

  const type: GarmentType = measurement && isGarment(measurement.garment_type) ? measurement.garment_type : "top";
  /* The family's own points, plus anything already stored that is not in that
     list — so a reading taken before a family changed is still shown and still
     editable, rather than silently dropped. */
  const keys: string[] = [
    ...POMS_FOR[type],
    ...Object.keys(draft).filter((k) => !(POMS_FOR[type] as string[]).includes(k)),
  ];

  const save = useCallback(async () => {
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      const pointsCm: Record<string, number> = {};
      for (const [k, v] of Object.entries(draft)) {
        const n = Number(String(v).replace(",", "."));
        if (Number.isFinite(n) && n > 0) pointsCm[k] = Number(n.toFixed(2));
      }
      if (!Object.keys(pointsCm).length) throw new Error("Nothing to save — enter at least one measurement.");
      const r = await fetch("/api/inventory/size-grading", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customSkuId,
          garmentType: type,
          pointsCm,
          note: "edited on the item card",
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; measuredAt?: string; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error ?? "Could not save");
      setMeasurement((m) => (m ? { ...m, points_cm: pointsCm, measured_at: j.measuredAt ?? m.measured_at } : m));
      setMsg("Saved.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }, [customSkuId, draft, type]);

  if (loading) {
    return (
      <p className="flex items-center gap-2 px-3 py-2 font-mono text-[0.8rem] text-[var(--wms-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading measurements…
      </p>
    );
  }

  if (!measurement && !editable) {
    return (
      <p className="px-3 py-2 font-mono text-[0.8rem] text-[var(--wms-muted)]">
        Not measured yet — use Inventory → Size Grading.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      <p className="font-mono text-[0.72rem] text-[var(--wms-muted)]">
        {measurement
          ? `${GARMENT_LABELS[type]} · measured ${new Date(measurement.measured_at).toLocaleDateString()}`
          : "Not measured yet — type the measurements in, or use Inventory → Size Grading."}
      </p>

      {keys.map((k) => {
        const raw = draft[k] ?? "";
        const n = Number(String(raw).replace(",", "."));
        const inches = Number.isFinite(n) && n > 0 ? `${(n / 2.54).toFixed(1)}"` : "";
        return (
          <label key={k} className="flex items-center justify-between gap-3 text-[0.85rem]">
            <span className="text-[var(--wms-muted)]">{POM_LABEL[k as PomKey] ?? k}</span>
            <span className="flex items-center gap-2">
              <span className="w-12 text-right font-mono text-[0.75rem] text-[var(--wms-muted)]">{inches}</span>
              <input
                type="text"
                inputMode="decimal"
                value={raw}
                disabled={!editable}
                onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                className="w-24 rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 text-right font-mono text-[var(--wms-fg)] disabled:opacity-60 max-md:min-h-11 max-md:text-base"
              />
              <span className="w-6 font-mono text-[0.75rem] text-[var(--wms-muted)]">cm</span>
            </span>
          </label>
        );
      })}

      {editable ? (
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <button
            type="button"
            className="wms-btn-primary wms-btn-sm max-md:min-h-11"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? "Saving…" : "Save measurements"}
          </button>
          {msg ? <span className="font-mono text-[0.72rem] text-[var(--wms-status-success-fg)]">{msg}</span> : null}
          {err ? <span className="font-mono text-[0.72rem] text-[var(--wms-status-danger-fg)]">{err}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

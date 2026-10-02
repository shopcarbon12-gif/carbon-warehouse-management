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
 * the most recent of each side.
 *
 * Front and back are held separately. Some points only exist on one side — a
 * back rise is not a front rise — and where both exist the pair is a free
 * cross-check on whether the garment was lying flat.
 *
 * Which points appear comes from the product's own category: a pair of evening
 * pants offers Waist and Inseam, not Chest and Sleeve.
 *
 * Inches are shown by default because that is what the floor measures in, with
 * a one-click switch to centimetres. Centimetres are what is STORED, always, so
 * switching units can never round a saved value.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Save } from "lucide-react";

import { GARMENT_LABELS, POMS_FOR, POM_LABEL, type GarmentType, type PomKey } from "@/lib/size-grading/garment";
import { familyForCategory } from "@/lib/size-grading/catalog-family";

type Measurement = {
  id: string;
  garment_type: string;
  points_cm: Record<string, number>;
  measured_at: string;
  note: string | null;
  view?: string;
};

const isGarment = (v: string): v is GarmentType => v in GARMENT_LABELS;

/** The floor works in inches; the spec sheets are in centimetres. Stored cm. */
const UNIT_KEY = "wms.sizeGrading.unit";

export function SizeGradingSection({
  customSkuId,
  editable,
  category,
  subcategory,
}: {
  customSkuId: string;
  editable: boolean;
  /** The product's merchandise category, so the right points are offered. */
  category?: string | null;
  subcategory?: string | null;
}) {
  const [loading, setLoading] = useState(true);
  /* Front and back are separate readings of the same garment, so the card
     carries both and the operator switches between them. Showing only the most
     recent would hide the front the moment the back was measured. */
  const [side, setSide] = useState<"front" | "back">("front");
  const [sides, setSides] = useState<{ front: Measurement | null; back: Measurement | null }>({
    front: null,
    back: null,
  });
  const measurement = sides[side];
  /** Text, not numbers: a half-typed "5." must survive a keystroke. */
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Inches by default — it is what the floor measures in. Remembered per device. */
  const [unit, setUnit] = useState<"in" | "cm">("in");
  useEffect(() => {
    try {
      if (window.localStorage.getItem(UNIT_KEY) === "cm") setUnit("cm");
    } catch {
      /* storage blocked — inches it is */
    }
  }, []);
  const toggleUnit = useCallback(() => {
    setUnit((u) => {
      const next = u === "in" ? "cm" : "in";
      try {
        window.localStorage.setItem(UNIT_KEY, next);
      } catch {
        /* nothing to remember it with */
      }
      return next;
    });
  }, []);

  /* What the catalogue says this product is. A pair of evening pants should
     offer Waist and Inseam, not Chest and Sleeve — and before this it offered
     Chest and Sleeve, because the fallback for "nothing measured yet" was
     "assume a top". */
  const fromCatalogue = useMemo(() => familyForCategory(category, subcategory), [category, subcategory]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        const r = await fetch(`/api/inventory/size-grading?customSkuId=${customSkuId}`);
        const j = (await r.json().catch(() => ({}))) as {
          front?: Measurement | null;
          back?: Measurement | null;
        };
        if (!alive) return;
        setSides({ front: j.front ?? null, back: j.back ?? null });
        // Open on whichever side has a reading, front first.
        const start: "front" | "back" = j.front ? "front" : j.back ? "back" : "front";
        setSide(start);
        const m = (start === "front" ? j.front : j.back) ?? null;
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

  /* A saved measurement knows its own family; otherwise the catalogue decides;
     only then fall back to a top. */
  const type: GarmentType =
    measurement && isGarment(measurement.garment_type)
      ? measurement.garment_type
      : fromCatalogue?.kind === "garment"
        ? fromCatalogue.type
        : "top";
  /* The family's own points, plus anything already stored that is not in that
     list — so a reading taken before a family changed is still shown and still
     editable, rather than silently dropped. */
  const keys: string[] = [
    ...POMS_FOR[type],
    ...Object.keys(draft).filter((k) => !(POMS_FOR[type] as string[]).includes(k)),
  ];

  /* Switching side swaps which reading is being edited. Done here rather than
     in the click handler so an unsaved edit on one side cannot leak onto the
     other. */
  const showSide = useCallback(
    (next: "front" | "back") => {
      setSide(next);
      const m = sides[next];
      setDraft(m ? Object.fromEntries(Object.entries(m.points_cm).map(([k, v]) => [k, String(v)])) : {});
      setMsg(null);
      setErr(null);
    },
    [sides],
  );

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
          view: side,
          note: "edited on the item card",
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; measuredAt?: string; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error ?? "Could not save");
      setSides((prev) => ({
        ...prev,
        [side]: {
          id: prev[side]?.id ?? "new",
          garment_type: type,
          points_cm: pointsCm,
          measured_at: j.measuredAt ?? new Date().toISOString(),
          note: "edited on the item card",
          view: side,
        },
      }));
      setMsg("Saved.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }, [customSkuId, draft, type, side]);

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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[0.72rem] text-[var(--wms-muted)]">
          {measurement
            ? `${GARMENT_LABELS[type]} · measured ${new Date(measurement.measured_at).toLocaleDateString()}`
            : fromCatalogue?.kind === "not-measurable"
              ? fromCatalogue.why
              : `${GARMENT_LABELS[type]} · not measured yet — type them in, or use Inventory → Size Grading.`}
        </p>
        <span className="inline-flex overflow-hidden rounded border border-[var(--wms-border)]">
          {(["front", "back"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => showSide(v)}
              className={`px-2 py-0.5 font-mono text-[0.7rem] capitalize max-md:min-h-9 ${
                side === v
                  ? "bg-[var(--wms-accent)] font-semibold text-[var(--wms-on-accent,#0c0f12)]"
                  : "text-[var(--wms-fg)]"
              }`}
            >
              {v}
              {sides[v] ? " ✓" : ""}
            </button>
          ))}
        </span>
        <button
          type="button"
          onClick={toggleUnit}
          className="rounded border border-[var(--wms-border)] px-2 py-0.5 font-mono text-[0.7rem] text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] max-md:min-h-9"
          title={`Showing ${unit === "in" ? "inches" : "centimetres"} — click for ${unit === "in" ? "cm" : "inches"}`}
        >
          {unit === "in" ? "inches" : "cm"} ⇄
        </button>
      </div>

      {keys.map((k) => {
        const raw = draft[k] ?? "";
        const n = Number(String(raw).replace(",", "."));
        /* Centimetres are what is stored, so the box shows the chosen unit and
           the other one sits beside it. Converting on display rather than on
           every keystroke keeps a half-typed "5." intact and means switching
           units can never round a saved value. */
        const shown = unit === "cm" ? raw : Number.isFinite(n) && n > 0 ? (n / 2.54).toFixed(2).replace(/\.?0+$/, "") : raw;
        const other =
          Number.isFinite(n) && n > 0 ? (unit === "cm" ? `${(n / 2.54).toFixed(1)}"` : `${n.toFixed(1)} cm`) : "";
        return (
          <label key={k} className="flex items-center justify-between gap-3 text-[0.85rem]">
            <span className="text-[var(--wms-muted)]">
              {k === "rise" && side === "back" ? "Back rise" : (POM_LABEL[k as PomKey] ?? k)}
            </span>
            <span className="flex items-center gap-2">
              <span className="w-16 text-right font-mono text-[0.75rem] text-[var(--wms-muted)]">{other}</span>
              <input
                type="text"
                inputMode="decimal"
                value={shown}
                disabled={!editable}
                onChange={(e) => {
                  const typed = e.target.value;
                  if (unit === "cm") {
                    setDraft((d) => ({ ...d, [k]: typed }));
                    return;
                  }
                  // Typed in inches: keep the draft in centimetres, which is
                  // the only unit anything downstream deals in.
                  const v = Number(typed.replace(",", "."));
                  setDraft((d) => ({ ...d, [k]: Number.isFinite(v) && typed.trim() ? String(+(v * 2.54).toFixed(2)) : "" }));
                }}
                className="w-24 rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 text-right font-mono text-[var(--wms-fg)] disabled:opacity-60 max-md:min-h-11 max-md:text-base"
              />
              <span className="w-6 font-mono text-[0.75rem] text-[var(--wms-muted)]">{unit === "cm" ? "cm" : "in"}</span>
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

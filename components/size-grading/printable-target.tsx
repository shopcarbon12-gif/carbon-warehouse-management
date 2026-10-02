"use client";

/**
 * The calibration target, drawn at exact physical size for printing.
 *
 * Every dimension comes from TARGET in lib/size-grading/target.ts — the same
 * constants the detector measures against. Drawing from one source is the whole
 * point: a target printed 5% larger than the detector believes would make every
 * measurement 5% wrong, consistently, invisibly and forever.
 *
 * Printed in centimetres with `@page { size: letter }` and scaling turned off.
 * The one thing that can still go wrong is a printer's "fit to page", which
 * silently shrinks the sheet — so the page prints a 10 cm rule next to the
 * target and asks the operator to check it with a tape before using it. That
 * takes five seconds once and removes the only remaining way this can be wrong.
 */

import { Printer } from "lucide-react";

import { TARGET } from "@/lib/size-grading/target";

export function PrintableTarget() {
  const { outerWCm: W, outerHCm: H, borderCm: B, dotCm: D, dotInsetCm: I } = TARGET;

  return (
    <>
      <style>{`
        @page { size: letter portrait; margin: 8mm; }
        @media print {
          .no-print { display: none !important; }
          html, body { background: #fff !important; }
          .target-sheet { box-shadow: none !important; border: none !important; }
          /* Black has to print black, not a dithered grey, or the edges the
             detector fits its lines to come out ragged. */
          .target-ink { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>

      <div className="mx-auto flex min-w-0 max-w-4xl flex-col gap-5">
        <div className="no-print border-b border-[var(--wms-border)] pb-3">
          <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Size Grading — calibration target</h1>
          <p className="mt-1 max-w-2xl font-mono text-xs text-[var(--wms-muted)]">
            Print this on US Letter at 100% — turn OFF &ldquo;fit to page&rdquo; and any scaling. Then check the 10 cm
            rule below with a tape measure before you use it.
          </p>
        </div>

        <div className="no-print flex flex-wrap items-center gap-3">
          <button type="button" className="wms-btn-primary max-md:min-h-11" onClick={() => window.print()}>
            <Printer className="h-4 w-4" /> Print
          </button>
          <span className="font-mono text-xs text-[var(--wms-muted)]">
            {W} × {H} cm · {B} cm border
          </span>
        </div>

        <div className="no-print rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3 text-sm text-[var(--wms-fg)]">
          <p className="font-semibold">How to use it</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-[var(--wms-muted)]">
            <li>Lay it flat on the surface you measure garments on, and tape it down so it cannot curl or move.</li>
            <li>
              Put the garment beside it — not on top of it — with both flat on the same surface. The whole target must
              be visible in every photo.
            </li>
            <li>Shoot from straight above. The app finds the target by itself; there is nothing to tap.</li>
            <li>
              Laminate it, or print a few. Paper on a warehouse floor curls and gets stepped on, and a curled target is
              a wrong target.
            </li>
          </ol>
        </div>

        <div className="target-sheet mx-auto bg-white p-[0.5cm] shadow-sm">
          {/* The ring. Drawn as a black box with a white box inside it, both at
              exact centimetre sizes, so what the printer puts on paper is what
              the detector expects to find. */}
          <div
            className="target-ink relative bg-black"
            style={{ width: `${W}cm`, height: `${H}cm` }}
          >
            <div
              className="absolute bg-white"
              style={{ left: `${B}cm`, top: `${B}cm`, width: `${W - 2 * B}cm`, height: `${H - 2 * B}cm` }}
            >
              {/* Orientation dot, so the target has a top-left even when the
                  sheet is turned round on the table. */}
              <div
                className="target-ink absolute bg-black"
                style={{ left: `${I}cm`, top: `${I}cm`, width: `${D}cm`, height: `${D}cm` }}
              />
              <div
                className="absolute left-0 right-0 text-center font-mono text-black"
                style={{ top: `${H / 2 - B - 1.6}cm`, fontSize: "10pt" }}
              >
                CARBON · SIZE GRADING TARGET
                <div style={{ fontSize: "8pt", marginTop: "0.15cm" }}>
                  {W} × {H} cm — do not scale
                </div>
              </div>

              {/* The check rule: 10 cm, with a mark every centimetre. If a tape
                  says this is not 10 cm, the print was scaled and the target
                  must not be used. */}
              <div
                className="absolute"
                style={{ left: "1cm", bottom: "1cm", width: "10cm" }}
              >
                <div className="target-ink relative bg-black" style={{ height: "0.08cm", width: "10cm" }} />
                <div className="relative" style={{ width: "10cm", height: "0.45cm" }}>
                  {Array.from({ length: 11 }, (_, i) => (
                    <div
                      key={i}
                      className="target-ink absolute bg-black"
                      style={{
                        left: `${i}cm`,
                        top: 0,
                        width: "0.06cm",
                        height: i % 5 === 0 ? "0.45cm" : "0.25cm",
                      }}
                    />
                  ))}
                </div>
                <div className="font-mono text-black" style={{ fontSize: "8pt" }}>
                  10 cm — measure this with a tape. If it is not 10 cm, reprint at 100%.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

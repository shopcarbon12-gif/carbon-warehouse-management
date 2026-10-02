import { getSession } from "@/lib/get-session";
import { GarmentSketch, SKETCHES, type SketchId } from "@/components/size-grading/garment-sketch";
import { POMS_FOR, type GarmentType } from "@/lib/size-grading/garment";
import { pomOnSide } from "@/lib/size-grading/pom-guide";

export const dynamic = "force-dynamic";

/**
 * How to measure — every garment family on one page, each as a single sketch
 * with all of its lines drawn on it in the colours the Size Grading page uses.
 *
 * Bottoms are shown twice because the pockets are on different sides: the
 * front pocket opening is measured front up, the back pocket back up.
 */
const PANELS: Array<{ sketch: SketchId; type: GarmentType; view: "front" | "back"; title?: string }> = [
  { sketch: "tee", type: "top", view: "front" },
  { sketch: "longsleeve", type: "top", view: "front" },
  { sketch: "trousers", type: "trousers", view: "front", title: "Jeans · pants · leggings — front" },
  { sketch: "trousers", type: "trousers", view: "back", title: "Jeans · pants · leggings — back" },
  { sketch: "shorts", type: "shorts", view: "front", title: "Shorts — front" },
  { sketch: "shorts", type: "shorts", view: "back", title: "Shorts — back" },
  { sketch: "dress", type: "dress", view: "front" },
  { sketch: "skirt", type: "skirt", view: "front" },
  { sketch: "onepiece", type: "onepiece", view: "front" },
];

export default async function SizeGradingGuidePage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">How to measure</h1>
        <p className="mt-1 max-w-2xl font-mono text-xs text-[var(--wms-muted)]">
          Every measurement is flat — straight across the garment as it lies, never doubled. Each colour matches its
          line on the Size Grading photo.
        </p>
      </div>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PANELS.map((p) => (
          <section
            key={`${p.sketch}-${p.view}`}
            className="flex min-w-0 flex-col gap-3 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3"
          >
            <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--wms-fg)]">
              {p.title ?? SKETCHES[p.sketch].title}
            </h2>
            <GarmentSketch
              sketch={p.sketch}
              type={p.type}
              view={p.view}
              keys={POMS_FOR[p.type].filter((k) => pomOnSide(k, p.view))}
            />
          </section>
        ))}
      </div>
    </div>
  );
}

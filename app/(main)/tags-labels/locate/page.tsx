import { getSession } from "@/lib/get-session";
import { LocateTagWorkspace } from "@/components/rfid/locate/locate-tag-workspace";

export const dynamic = "force-dynamic";

export default async function LocateTagPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-5xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Locate Tag</h1>
        <p className="mt-1 max-w-2xl font-mono text-xs text-[var(--wms-muted)]">
          Pick one tag and the readers to hunt with, then press Scan. Each reader shows a live signal
          bar and a rough distance while it hears the tag. Refine ramps a single reader&apos;s power
          from 10 to 33 dBm and reports the lowest power the tag answers at — the closest thing to a
          real measurement a fixed reader can give.
        </p>
      </div>
      <LocateTagWorkspace />
    </div>
  );
}

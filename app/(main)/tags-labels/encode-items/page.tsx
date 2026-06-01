import { redirect } from "next/navigation";
import { EncodeItemsWorkspace } from "@/components/rfid/encode-items/encode-items-workspace";
import { getSession } from "@/lib/get-session";

export const dynamic = "force-dynamic";

export default async function EncodeItemsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  return (
    <div className="space-y-4">
      <div className="border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Encode Items</h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Re-encode an already-stuck tag without reprinting. Pick a reader, hit Read to stream EPCs
          into the table, then check the tags you want and search for the target SKU. Click Encode to
          rotate each checked tag&apos;s identity to the new SKU&apos;s system ID with a fresh serial.
        </p>
      </div>
      <EncodeItemsWorkspace />
    </div>
  );
}

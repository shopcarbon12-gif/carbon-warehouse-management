import { getSession } from "@/lib/get-session";
import { PrintableTarget } from "@/components/size-grading/printable-target";

export const dynamic = "force-dynamic";

/**
 * The printable calibration target.
 *
 * Deliberately a page rather than a PDF in the repo: a PDF would have to be
 * kept in step with the dimensions the detector expects, and the day someone
 * updates one and not the other, every measurement taken afterwards is wrong by
 * a percentage nobody can see. Here the page is drawn FROM the same constants
 * the detector measures against, so the two cannot drift apart.
 */
export default async function SizeGradingTargetPage() {
  const session = await getSession();
  if (!session) return null;
  return <PrintableTarget />;
}

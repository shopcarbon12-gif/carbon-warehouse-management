import { redirect } from "next/navigation";

// Legacy /operations/transfers — superseded by /inventory/transfers/out (menu regroup).
export default function TransfersLegacyRedirect() {
  redirect("/inventory/transfers/out");
}

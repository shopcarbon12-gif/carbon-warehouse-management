import { redirect } from "next/navigation";

// Legacy /operations/transfers — superseded by /operations/transfers/out (action page).
export default function TransfersLegacyRedirect() {
  redirect("/operations/transfers/out");
}

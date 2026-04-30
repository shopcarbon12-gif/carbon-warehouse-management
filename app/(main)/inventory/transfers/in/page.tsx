import { redirect } from "next/navigation";

// Moved to Reports section.
export default function TransferInReportRedirect() {
  redirect("/reports/transfers/in");
}

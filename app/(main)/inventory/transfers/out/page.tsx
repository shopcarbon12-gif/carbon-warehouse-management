import { redirect } from "next/navigation";

// Moved to Reports section.
export default function TransferOutReportRedirect() {
  redirect("/reports/transfers/out");
}

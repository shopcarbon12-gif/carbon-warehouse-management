import { redirect } from "next/navigation";

export default function SyncLegacyRedirect() {
  redirect("/inventory/sync");
}

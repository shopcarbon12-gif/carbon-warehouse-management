import { redirect } from "next/navigation";
import { getSession } from "@/lib/get-session";
import { envCompanyPrefix } from "@/lib/server/rfid-commission";
import { PrintTagsWorkspace } from "@/components/tags-labels/print-tags-workspace";

export const dynamic = "force-dynamic";

export default async function RfidTagsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  return <PrintTagsWorkspace mode="rfid" companyPrefix={envCompanyPrefix()} />;
}

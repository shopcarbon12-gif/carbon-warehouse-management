import { getSession } from "@/lib/get-session";
import { CommandCenter } from "@/components/dashboard/command-center";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) return null;

  return <CommandCenter />;
}

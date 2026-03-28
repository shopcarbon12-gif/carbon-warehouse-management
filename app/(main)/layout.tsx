import { redirect } from "next/navigation";
import { WmsShell } from "@/components/wms-shell";
import { getSession } from "@/lib/get-session";

export default async function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  return (
    <WmsShell activeLocationId={session.lid}>{children}</WmsShell>
  );
}

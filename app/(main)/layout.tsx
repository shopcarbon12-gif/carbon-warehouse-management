import { redirect } from "next/navigation";
import { DevLocalDbBanner } from "@/components/dev-local-db-banner";
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
    <WmsShell activeLocationId={session.lid} banner={<DevLocalDbBanner />}>
      {children}
    </WmsShell>
  );
}

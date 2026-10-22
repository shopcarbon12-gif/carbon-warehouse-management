import { headers } from "next/headers";
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

  // The CarbonGradingAI app opens CarbonWMS pages in its own WebView: show the page without the CarbonWMS menus.
  const embedded = /\bCarbonGradingAI\b/.test((await headers()).get("user-agent") ?? "");

  return (
    <WmsShell activeLocationId={session.lid} banner={<DevLocalDbBanner />} embedded={embedded}>
      {children}
    </WmsShell>
  );
}

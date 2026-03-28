import type { Metadata } from "next";
import { Outfit, JetBrains_Mono } from "next/font/google";
import { WmsNav } from "@/components/WmsNav";
import "./globals.css";

const wmsSans = Outfit({
  variable: "--font-wms-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const wmsMono = JetBrains_Mono({
  variable: "--font-wms-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Carbon WMS — Orlando 001",
  description:
    "Carbon Jeans Orlando Warehouse 001 — inventory, orders, Shopify, Lightspeed, Senitron RFID.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${wmsSans.variable} ${wmsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-[var(--background)]">
        <WmsNav />
        {children}
      </body>
    </html>
  );
}

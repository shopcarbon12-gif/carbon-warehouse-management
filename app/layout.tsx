import type { Metadata } from "next";
import { Outfit, JetBrains_Mono } from "next/font/google";
import { WMS_THEME_FONT_BOOT_SCRIPT } from "@/lib/theme-boot";
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
  title: "CarbonWMS",
  description: "CarbonWMS — warehouse management, inventory, lots, and operations.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${wmsSans.variable} ${wmsMono.variable} h-full antialiased dark`}
      data-theme="dark"
      suppressHydrationWarning
    >
      <head>
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: WMS_THEME_FONT_BOOT_SCRIPT }}
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import { Outfit, JetBrains_Mono } from "next/font/google";
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
  icons: {
    icon: [{ url: "/carbonwms-icon.png", type: "image/png" }],
    apple: [{ url: "/carbonwms-icon.png", type: "image/png" }],
  },
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
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

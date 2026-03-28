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
  title: "Carbon WMS",
  description: "Carbon warehouse management — inventory, lots, and operations.",
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
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

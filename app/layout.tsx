import type { Metadata, Viewport } from "next";
import { Outfit, JetBrains_Mono } from "next/font/google";
import { WMS_THEME_BOOT_SCRIPT } from "@/lib/theme-boot";
import { ORLANDO_TIME_PATCH } from "@/lib/orlando-time";
import { TextSelectionClickGuard } from "@/components/text-selection-click-guard";
import "./globals.css";

// Orlando is the default display time zone on the server too.
// eslint-disable-next-line no-new-func
new Function(ORLANDO_TIME_PATCH)();

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

// Explicit viewport (was Next's implicit default): viewportFit "cover"
// activates env(safe-area-inset-*) on notched phones for mobile-view
// fixed chrome. No maximumScale/userScalable caps — pinch-zoom stays
// available (a11y); iOS focus-zoom is handled with ≥16px inputs instead.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
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
      suppressHydrationWarning
    >
      <head>
        {/* Orlando time for every date/time display, before any app code runs. */}
        <script dangerouslySetInnerHTML={{ __html: ORLANDO_TIME_PATCH }} />
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: WMS_THEME_BOOT_SCRIPT }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        <TextSelectionClickGuard />
        {children}
      </body>
    </html>
  );
}

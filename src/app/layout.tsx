import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk, Heebo } from "next/font/google";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n/useI18n";
import NavShell from "./NavShell";

// Body / UI face (Latin). Hebrew glyphs fall through to Heebo in the CSS stack.
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

// Display face for headings and the big metric readouts — geometric, with
// real tabular figures so changing numbers don't jitter.
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
});

// Hebrew face, paired with Inter/Space Grotesk for the RTL UI.
const heebo = Heebo({
  subsets: ["hebrew", "latin"],
  display: "swap",
  variable: "--font-hebrew",
});

export const metadata: Metadata = {
  title: "Health Tracker",
  description: "Log nutrition via chat & images, sync workouts from Apple Health",
};

export const viewport: Viewport = {
  // Lock zoom-out so the fixed header/tab bar stay put; allow zoom-in for a11y.
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#fbfaf7",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${spaceGrotesk.variable} ${heebo.variable}`}>
      <body>
        <I18nProvider>
          <NavShell>{children}</NavShell>
        </I18nProvider>
      </body>
    </html>
  );
}

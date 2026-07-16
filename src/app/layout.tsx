import type { Metadata } from "next";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n/useI18n";
import NavShell from "./NavShell";

export const metadata: Metadata = {
  title: "Health Tracker",
  description: "Log nutrition via chat & images, sync workouts from Apple Health",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <I18nProvider>
          <NavShell>{children}</NavShell>
        </I18nProvider>
      </body>
    </html>
  );
}

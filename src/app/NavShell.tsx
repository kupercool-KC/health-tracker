"use client";

/**
 * App shell: header (app name + EN/עב toggle), 3-tab nav (Today/History/
 * Profile), and the floating chat button. The FAB just opens/closes a
 * placeholder panel for now — actual chat behavior (log-meal / query-history
 * modes) is a later phase.
 */
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useI18n } from "@/lib/i18n/useI18n";

const TABS = [
  { href: "/today", labelKey: "navToday" as const },
  { href: "/history", labelKey: "navHistory" as const },
  { href: "/profile", labelKey: "navProfile" as const },
];

export default function NavShell({ children }: { children: ReactNode }) {
  const { t, lang, setLang } = useI18n();
  const pathname = usePathname();
  const [chatOpen, setChatOpen] = useState(false);

  return (
    <>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "12px 16px",
          borderBottom: "0.5px solid var(--border)",
          background: "var(--panel)",
        }}
      >
        <strong>{t("appName")}</strong>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            onClick={() => setLang("en")}
            style={{ fontWeight: lang === "en" ? 700 : 400, border: "none", background: "none" }}
          >
            EN
          </button>
          <button
            onClick={() => setLang("he")}
            style={{ fontWeight: lang === "he" ? 700 : 400, border: "none", background: "none" }}
          >
            עב
          </button>
        </div>
      </header>

      {children}

      <nav
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          display: "flex",
          borderTop: "0.5px solid var(--border)",
          background: "var(--panel)",
        }}
      >
        {TABS.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            style={{
              flex: 1,
              textAlign: "center",
              padding: "12px 0",
              color: pathname?.startsWith(tab.href) ? "var(--protein)" : "var(--muted)",
              fontWeight: pathname?.startsWith(tab.href) ? 700 : 400,
              textDecoration: "none",
            }}
          >
            {t(tab.labelKey)}
          </Link>
        ))}
      </nav>

      <button
        onClick={() => setChatOpen((v) => !v)}
        aria-label="Open chat"
        style={{
          position: "fixed",
          bottom: 72,
          insetInlineEnd: 16,
          width: 56,
          height: 56,
          borderRadius: "50%",
          background: "var(--protein)",
          color: "white",
          border: "none",
          fontSize: 24,
        }}
      >
        💬
      </button>

      {chatOpen && (
        <div
          className="card"
          style={{
            position: "fixed",
            bottom: 136,
            insetInlineEnd: 16,
            width: 300,
            padding: 16,
          }}
        >
          <p style={{ color: "var(--muted)", margin: 0 }}>Chat coming soon.</p>
        </div>
      )}
    </>
  );
}

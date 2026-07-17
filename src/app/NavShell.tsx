"use client";

/**
 * App shell: single top header row (app name, Today/History links, EN/עב
 * toggle, profile icon) and the floating chat button. The FAB just
 * opens/closes a placeholder panel for now — actual chat behavior (log-meal
 * / query-history modes) is a later phase.
 */
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useI18n } from "@/lib/i18n/useI18n";
import { useAuth } from "@/lib/firebase/useAuth";

const TABS = [
  { href: "/today", labelKey: "navToday" as const },
  { href: "/history", labelKey: "navHistory" as const },
];

export default function NavShell({ children }: { children: ReactNode }) {
  const { t, lang, setLang } = useI18n();
  const { user } = useAuth();
  const pathname = usePathname();
  const [chatOpen, setChatOpen] = useState(false);

  const initial = (user?.displayName ?? user?.email ?? "?").charAt(0).toUpperCase();

  return (
    <>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 16,
          padding: "12px 16px",
          borderBottom: "0.5px solid var(--border)",
          background: "var(--panel)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <strong>{t("appName")}</strong>
          <nav style={{ display: "flex", gap: 12 }}>
            {TABS.map((tab) => (
              <Link
                key={tab.href}
                href={tab.href}
                style={{
                  color: pathname?.startsWith(tab.href) ? "var(--protein)" : "var(--muted)",
                  fontWeight: pathname?.startsWith(tab.href) ? 700 : 400,
                  textDecoration: "none",
                }}
              >
                {t(tab.labelKey)}
              </Link>
            ))}
          </nav>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
          <Link
            href="/profile"
            aria-label={t("navProfile")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 32,
              height: 32,
              borderRadius: "50%",
              background: pathname?.startsWith("/profile") ? "var(--protein)" : "var(--bg-muted)",
              color: pathname?.startsWith("/profile") ? "white" : "var(--text)",
              fontWeight: 700,
              textDecoration: "none",
            }}
          >
            {initial}
          </Link>
        </div>
      </header>

      {children}

      <button
        onClick={() => setChatOpen((v) => !v)}
        aria-label="Open chat"
        style={{
          position: "fixed",
          bottom: 16,
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
            bottom: 80,
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

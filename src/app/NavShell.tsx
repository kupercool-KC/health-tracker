"use client";

/**
 * App shell: a compact sticky header (wordmark + EN/עב toggle) and a
 * thumb-reachable bottom tab bar (Today / History / Profile). The chat FAB
 * floats just above the tab bar and toggles the full-screen ChatPanel.
 */
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { useI18n } from "@/lib/i18n/useI18n";
import { useAuth } from "@/lib/firebase/useAuth";
import ChatPanel from "./ChatPanel";

function TodayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
      <path d="M5.5 3.5v3.5h3.5" />
      <path d="M12 7.5V12l3 1.8" />
    </svg>
  );
}

function ProfileIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8.5" r="3.75" />
      <path d="M5 20c1.2-3.6 4-5.4 7-5.4s5.8 1.8 7 5.4" />
    </svg>
  );
}

const TABS = [
  { href: "/today", labelKey: "navToday" as const, Icon: TodayIcon },
  { href: "/history", labelKey: "navHistory" as const, Icon: HistoryIcon },
  { href: "/profile", labelKey: "navProfile" as const, Icon: ProfileIcon },
];

// Routes that don't require onboarding — /share is public/unauthenticated,
// /onboarding is the destination itself (redirecting into it would loop).
const ONBOARDING_EXEMPT_PREFIXES = ["/onboarding", "/share"];

export default function NavShell({ children }: { children: ReactNode }) {
  const { t, lang, setLang } = useI18n();
  const { user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  // Two flags so the panel can slide out before it unmounts: `chatRender`
  // keeps it in the tree, `chatShown` drives the open/closed transform.
  const [chatRender, setChatRender] = useState(false);
  const [chatShown, setChatShown] = useState(false);

  function openChat() {
    setChatRender(true);
    // mount in the closed position, let it paint, then transition to open
    requestAnimationFrame(() => requestAnimationFrame(() => setChatShown(true)));
  }
  function closeChat() {
    setChatShown(false);
    window.setTimeout(() => setChatRender(false), 260);
  }

  const onShare = pathname?.startsWith("/share") ?? false;
  const showChrome = !onShare;

  useEffect(() => {
    if (!user) return;
    if (ONBOARDING_EXEMPT_PREFIXES.some((p) => pathname?.startsWith(p))) return;

    const ref = doc(db, "users", user.uid, "meta", "profile");
    const unsubscribe = onSnapshot(ref, (snap) => {
      if (snap.data()?.onboarded !== true) {
        router.push("/onboarding");
      }
    });
    return unsubscribe;
  }, [user, pathname, router]);

  return (
    <>
      {showChrome && (
        <header className="app-header">
          <Link href="/today" className="app-header__mark">
            <span className="app-header__dot" aria-hidden="true" />
            {t("appName")}
          </Link>

          <div className="lang-toggle" data-lang={lang} role="group" aria-label="Language">
            <button onClick={() => setLang("en")} aria-pressed={lang === "en"}>
              EN
            </button>
            <button onClick={() => setLang("he")} aria-pressed={lang === "he"}>
              עב
            </button>
          </div>
        </header>
      )}

      <div id="page-content">{children}</div>

      {showChrome && user && (
        <>
          <nav className="tabbar" aria-label={t("appName")}>
            {TABS.map((tab) => {
              const active = pathname?.startsWith(tab.href) ?? false;
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  aria-current={active ? "page" : undefined}
                  className={`tabbar__item${active ? " tabbar__item--active" : ""}`}
                >
                  <tab.Icon />
                  {t(tab.labelKey)}
                </Link>
              );
            })}
          </nav>

          <button
            onClick={() => (chatRender ? closeChat() : openChat())}
            aria-label={t("navChat")}
            className="chat-fab"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 5h16v11H8l-4 4z" />
            </svg>
          </button>

          {chatRender && <ChatPanel state={chatShown ? "open" : "closed"} onClose={closeChat} />}
        </>
      )}
    </>
  );
}

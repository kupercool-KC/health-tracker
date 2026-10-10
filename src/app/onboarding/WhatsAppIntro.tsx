"use client";

import { useEffect, useState } from "react";
import { auth } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/useAuth";
import { useI18n } from "@/lib/i18n/useI18n";
import { getFullProfile } from "@/lib/profile/queries";
import type { StringKey } from "@/lib/i18n/strings";

const SLIDES: { title: StringKey; body: StringKey; icon: string }[] = [
  { title: "waIntro1Title", body: "waIntro1Body", icon: "💬" },
  { title: "waIntro2Title", body: "waIntro2Body", icon: "🎙️" },
  { title: "waIntro3Title", body: "waIntro3Body", icon: "📷" },
  { title: "waIntro4Title", body: "waIntro4Body", icon: "🍽️" },
  { title: "waIntro5Title", body: "waIntro5Body", icon: "🏃" },
];

/**
 * First onboarding screens: what Lily can do over WhatsApp, then (optionally) link the number right away with the
 * same one-time-code flow as Profile (the number is proven by sending the code from WhatsApp).
 */
export default function WhatsAppIntro({ onDone }: { onDone: () => void }) {
  const { user } = useAuth();
  const { t } = useI18n();
  const [index, setIndex] = useState(0); // 0..SLIDES.length-1 = slides, SLIDES.length = connect screen
  const [code, setCode] = useState<{ code: string; botNumber: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [linked, setLinked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function getCode() {
    setBusy(true);
    setError(null);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) throw new Error("Not signed in");
      const res = await fetch("/api/whatsapp/link", { method: "POST", headers: { Authorization: `Bearer ${idToken}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setCode({ code: data.code, botNumber: data.botNumber ?? null });
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  // After the code is shown, watch for the number to be linked (the server links it when the code arrives on WhatsApp).
  useEffect(() => {
    if (!user || !code || linked) return;
    const timer = setInterval(() => {
      getFullProfile(user.uid).then((p) => {
        if (p?.whatsappPhone) setLinked(true);
      });
    }, 3000);
    return () => clearInterval(timer);
  }, [user, code, linked]);

  const onSlide = index < SLIDES.length;
  const slide = SLIDES[index];

  return (
    <main>
      <section style={{ display: "grid", gap: 14 }}>
        {onSlide ? (
          <>
            <div aria-hidden style={{ fontSize: 44 }}>{slide.icon}</div>
            <h1 style={{ margin: 0 }}>{t(slide.title)}</h1>
            <p style={{ margin: 0, color: "var(--muted)", lineHeight: 1.6 }}>{t(slide.body)}</p>
            <div style={{ display: "flex", gap: 6 }} aria-hidden>
              {SLIDES.map((_, i) => (
                <span key={i} style={{ width: i === index ? 18 : 6, height: 6, borderRadius: 3, background: i === index ? "var(--protein)" : "var(--line)" }} />
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <button onClick={onDone} style={{ background: "none", color: "var(--muted)" }}>{t("waIntroSkip")}</button>
              <button onClick={() => setIndex((i) => i + 1)}>{t("waIntroNext")}</button>
            </div>
          </>
        ) : linked ? (
          <>
            <div aria-hidden style={{ fontSize: 44 }}>✅</div>
            <h1 style={{ margin: 0 }}>{t("waConnectedTitle")}</h1>
            <p style={{ margin: 0, color: "var(--muted)" }}>{t("waConnectedBody")}</p>
            <div><button onClick={onDone}>{t("waConnectContinue")}</button></div>
          </>
        ) : (
          <>
            <h1 style={{ margin: 0 }}>{t("waConnectTitle")}</h1>
            <p style={{ margin: 0, color: "var(--muted)", lineHeight: 1.6 }}>{t("waConnectBody")}</p>
            {code ? (
              <div style={{ display: "grid", gap: 8 }}>
                <span style={{ fontSize: 13 }}>{t("whatsappCodeInstructions")}</span>
                <bdi dir="ltr" style={{ fontSize: 28, fontWeight: 600, letterSpacing: 4 }}>{code.code}</bdi>
                {code.botNumber && (
                  <a href={`https://wa.me/${code.botNumber}?text=${code.code}`} target="_blank" rel="noreferrer">
                    {t("whatsappOpenChatButton")}
                  </a>
                )}
                <span style={{ color: "var(--muted)", fontSize: 12 }}>{t("whatsappWaitingForCode")}</span>
              </div>
            ) : (
              <div>
                <button onClick={getCode} disabled={busy}>{busy ? t("working") : t("waConnectButton")}</button>
              </div>
            )}
            {error && <p style={{ color: "#ff6b6b", fontSize: 12, margin: 0 }}>{error}</p>}
            <div>
              <button onClick={onDone} style={{ background: "none", color: "var(--muted)" }}>{t("waIntroSkip")}</button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

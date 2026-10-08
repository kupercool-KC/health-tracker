"use client";

import { useState } from "react";
import { doc, setDoc } from "firebase/firestore";
import Link from "next/link";
import { db } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/useAuth";
import { useI18n } from "@/lib/i18n/useI18n";

/**
 * Blocks the app until the signed-in user agrees to send their data to the AI provider.
 * App Store guideline 5.1.2(i): name the third party (OpenAI), say what is sent and why,
 * ask explicitly (nothing pre-ticked), and let the user say no.
 */
export default function ConsentGate({ onDone }: { onDone: () => void }) {
  const { user, signOutUser } = useAuth();
  const { t } = useI18n();
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);

  async function accept() {
    if (!user || !agree) return;
    setBusy(true);
    try {
      await setDoc(doc(db, "users", user.uid, "meta", "profile"), { aiConsentAt: new Date().toISOString(), aiConsentVersion: 1 }, { merge: true });
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="consent-title" style={{ position: "fixed", inset: 0, zIndex: 1000, background: "var(--bg, #fff)", overflowY: "auto", padding: "max(24px, env(safe-area-inset-top)) 20px 32px" }}>
      <div style={{ maxWidth: 560, margin: "0 auto", display: "grid", gap: 14 }}>
        <h1 id="consent-title" style={{ fontSize: 24, margin: 0 }}>{t("consentTitle")}</h1>
        <p style={{ margin: 0, lineHeight: 1.6 }}>{t("consentIntro")}</p>
        <ul style={{ margin: 0, paddingInlineStart: 20, lineHeight: 1.7 }}>
          <li>{t("consentWhat")}</li>
          <li>{t("consentWho")}</li>
          <li>{t("consentWhy")}</li>
          <li>{t("consentRetention")}</li>
          <li>{t("consentWithdraw")}</li>
        </ul>
        <p style={{ margin: 0 }}>
          <Link href="/privacy" style={{ color: "var(--protein)" }}>{t("privacyPolicyLink")}</Link>
        </p>
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
          <input id="consent-check" type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} style={{ marginTop: 4 }} />
          <span>{t("consentCheckbox")}</span>
        </label>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button className="btn-primary" onClick={accept} disabled={!agree || busy}>
            {busy ? t("working") : t("consentAccept")}
          </button>
          <button onClick={() => signOutUser()} style={{ background: "none", color: "var(--muted)" }}>
            {t("consentDecline")}
          </button>
        </div>
      </div>
    </div>
  );
}

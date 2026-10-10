"use client";

import { useEffect, useState } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/useAuth";
import { useI18n } from "@/lib/i18n/useI18n";
import type { UserProfile } from "@/lib/types";

/** WhatsApp delivery switches for the daily insight and the weekly review. Both are ON unless switched off. */
export default function InsightPrefsCard() {
  const { user } = useAuth();
  const { t } = useI18n();
  const [prefs, setPrefs] = useState<NonNullable<UserProfile["insightPrefs"]>>({});
  const [linked, setLinked] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!user) return;
    getDoc(doc(db, "users", user.uid, "meta", "profile"))
      .then((snap) => {
        const p = snap.data() as UserProfile | undefined;
        setPrefs(p?.insightPrefs ?? {});
        setLinked(!!p?.whatsappPhone);
        setReady(true);
      })
      .catch(() => {});
  }, [user]);

  if (!user || !ready) return null;

  async function set(key: "dailyInsightWhatsapp" | "weeklyReviewWhatsapp", value: boolean) {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    await setDoc(doc(db, "users", user!.uid, "meta", "profile"), { insightPrefs: next, updatedAt: new Date().toISOString() }, { merge: true });
  }

  return (
    <div className="card" style={{ marginTop: 16, display: "grid", gap: 8 }}>
      <h2 style={{ margin: 0 }}>{t("insightPrefsTitle")}</h2>
      {!linked && <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>{t("insightPrefsNeedsLink")}</p>}
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input id="pref-daily" type="checkbox" disabled={!linked} checked={prefs.dailyInsightWhatsapp !== false} onChange={(e) => set("dailyInsightWhatsapp", e.target.checked)} />
        <span>{t("insightDailyWa")}</span>
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input id="pref-weekly" type="checkbox" disabled={!linked} checked={prefs.weeklyReviewWhatsapp !== false} onChange={(e) => set("weeklyReviewWhatsapp", e.target.checked)} />
        <span>{t("insightWeeklyWa")}</span>
      </label>
    </div>
  );
}

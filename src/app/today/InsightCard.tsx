"use client";

import { useCallback, useEffect, useState } from "react";
import { collection, doc, getDocs, limit, orderBy, query, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/useAuth";
import { useI18n } from "@/lib/i18n/useI18n";
import { recordGoalChange } from "@/lib/goals/goalHistory";
import type { Insight } from "@/lib/types";

/** One insight at a time on Today: this week's review if there is one, otherwise today's insight. */
export default function InsightCard({ calorieGoal, proteinGoal }: { calorieGoal: number; proteinGoal: number }) {
  const { user } = useAuth();
  const { t } = useI18n();
  const [insight, setInsight] = useState<Insight | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    const snap = await getDocs(query(collection(db, "users", user.uid, "insights"), orderBy("createdAt", "desc"), limit(6)));
    const now = Date.now();
    const live = snap.docs.map((d) => d.data() as Insight).filter((i) => i.status !== "dismissed" && i.status !== "acted" && Date.parse(i.expiresAt) > now);
    const pick = live.find((i) => i.kind === "weekly") ?? live.find((i) => i.kind === "daily") ?? null;
    setInsight(pick);
    if (pick && pick.status === "new") {
      setDoc(doc(db, "users", user.uid, "insights", pick.id), { status: "shown" }, { merge: true }).catch(() => {});
    }
  }, [user]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  if (!user || !insight) return notice ? <p style={{ color: "var(--muted)", fontSize: 13 }}>{notice}</p> : null;

  const mark = (status: Insight["status"]) => setDoc(doc(db, "users", user.uid, "insights", insight.id), { status }, { merge: true });

  async function act() {
    const a = insight!.action;
    if (!a) return;
    if (a.kind === "askLily") {
      try {
        sessionStorage.setItem("lily:prefill", a.prompt);
      } catch {
        /* prefill is a convenience only */
      }
      window.dispatchEvent(new CustomEvent("lily:ask"));
      await mark("acted");
      setInsight(null);
    } else {
      await setDoc(doc(db, "users", user!.uid, "meta", "profile"), { calorieGoal: a.value, updatedAt: new Date().toISOString() }, { merge: true });
      await recordGoalChange(user!.uid, { calorieGoal, proteinGoal }, { calorieGoal: a.value, proteinGoal });
      await mark("acted");
      setInsight(null);
      setNotice(t("insightGoalUpdated"));
    }
  }

  async function dismiss() {
    await mark("dismissed");
    setInsight(null);
  }

  return (
    <section style={{ marginTop: 16 }}>
      <div className="card" style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <strong>{insight.title}</strong>
          {insight.kind === "weekly" && <span style={{ color: "var(--muted)", fontSize: 12 }}>{t("insightWeeklyBadge")}</span>}
        </div>
        <p style={{ margin: 0, fontSize: 14, whiteSpace: "pre-line" }}>{insight.body}</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {insight.action && <button onClick={act}>{insight.action.label}</button>}
          <button onClick={dismiss} style={{ background: "none", color: "var(--muted)" }}>
            {insight.action?.kind === "applyCalorieGoal" ? insight.action.keepLabel : t("insightNotUseful")}
          </button>
        </div>
      </div>
    </section>
  );
}

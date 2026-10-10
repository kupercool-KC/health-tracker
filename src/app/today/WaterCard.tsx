"use client";

import { useCallback, useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/useAuth";
import { useI18n } from "@/lib/i18n/useI18n";
import { localDateKey } from "@/lib/dashboard/queries";
import { WATER_QUICK_ADD_ML } from "@/lib/water/water";
import type { WaterDay } from "@/lib/types";

/** Today's water: progress toward the goal, quick-add buttons, a custom amount and undo. */
export default function WaterCard({ goalMl, refreshKey }: { goalMl: number; refreshKey?: number }) {
  const { user } = useAuth();
  const { t } = useI18n();
  const [day, setDay] = useState<WaterDay | null>(null);
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState("");
  const date = localDateKey();

  const load = useCallback(async () => {
    if (!user) return;
    const snap = await getDoc(doc(db, "users", user.uid, "water", date));
    setDay((snap.data() as WaterDay | undefined) ?? null);
  }, [user, date]);
  useEffect(() => {
    load().catch(() => {});
  }, [load, refreshKey]);

  async function call(body: { ml?: number; undo?: boolean }) {
    setBusy(true);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      const res = await fetch("/api/water", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ ...body, date }),
      });
      if (res.ok) setDay(((await res.json()) as { day: WaterDay | null }).day);
    } finally {
      setBusy(false);
    }
  }

  const ml = day?.ml ?? 0;
  const pct = goalMl > 0 ? Math.min(100, Math.round((ml / goalMl) * 100)) : 0;
  const reached = ml >= goalMl;

  return (
    <section style={{ marginTop: 16 }}>
      <div className="card" style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <strong>{t("waterTitle")}</strong>
          <bdi dir="ltr" style={{ color: "var(--muted)", fontSize: 13 }}>
            {ml} / {goalMl} {t("unitMl")}
          </bdi>
        </div>
        <div style={{ height: 8, borderRadius: 4, background: "var(--line)", overflow: "hidden" }} role="progressbar" aria-valuenow={ml} aria-valuemax={goalMl}>
          <div style={{ width: `${pct}%`, height: "100%", background: "#3b8fb0" }} />
        </div>
        <span style={{ color: reached ? "var(--burned)" : "var(--muted)", fontSize: 12 }}>
          {reached ? t("waterReached") : t("waterToGo").replace("{n}", String(goalMl - ml))}
        </span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {WATER_QUICK_ADD_ML.map((n) => (
            <button key={n} type="button" disabled={busy} onClick={() => call({ ml: n })}>
              <bdi dir="ltr">+{n}</bdi>
            </button>
          ))}
          {(day?.entries.length ?? 0) > 0 && (
            <button type="button" disabled={busy} onClick={() => call({ undo: true })} style={{ background: "none", color: "var(--muted)" }}>
              {t("waterUndo")}
            </button>
          )}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(custom);
            if (n > 0 && n <= 5000) {
              call({ ml: n });
              setCustom("");
            }
          }}
          style={{ display: "flex", gap: 8 }}
        >
          <input id="water-custom" type="number" inputMode="numeric" min={1} max={5000} placeholder={t("waterCustom")} value={custom} onChange={(e) => setCustom(e.target.value)} style={{ flex: 1, minWidth: 0, padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }} />
          <button type="submit" disabled={busy || !custom}>{t("waterAdd")}</button>
        </form>
      </div>
    </section>
  );
}

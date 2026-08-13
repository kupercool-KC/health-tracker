"use client";

/**
 * Profile screen. Full 4-section spec (dietary profile, alerts, memory,
 * goals & display) is a later phase — this ships the Apple Health sync
 * token management (previously at /settings) plus a quick goal-editing
 * shortcut, so the nav's profile icon has real content rather than a
 * placeholder. The full onboarding wizard (BMR/TDEE calculation) is still a
 * separate follow-up — this is a stopgap that lets you just type numbers in.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { doc, setDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase/client";
import { AUTH_REDIRECT_LOST, useAuth } from "@/lib/firebase/useAuth";
import { useI18n } from "@/lib/i18n/useI18n";
import { isAdmin } from "@/lib/admin";
import { getUserGoals } from "@/lib/profile/queries";
import { getMealDaysSince, getWorkoutsSince, localDateKey, localDateKeyDaysAgo } from "@/lib/dashboard/queries";
import { computeNetCalories } from "@/lib/goals/netCalories";

export default function Profile() {
  const { user, loading: authLoading, authError, signIn, signOutUser } = useAuth();
  const { t, forwardArrow } = useI18n();
  const [error, setError] = useState<string | null>(null);

  // Kept as raw strings, not numbers — a controlled type="number" input
  // backed by numeric state doesn't reliably strip a leading "0" as you type
  // over it (e.g. typing "22" over "0" can leave "022" on screen even though
  // the parsed number is correct). Parsing only happens on save.
  const [calorieGoal, setCalorieGoal] = useState("1950");
  const [proteinGoal, setProteinGoal] = useState("145");
  const [stepGoal, setStepGoal] = useState("10000");
  const [netFactor, setNetFactor] = useState("50");
  const [goalsBusy, setGoalsBusy] = useState(false);
  const [goalsSaved, setGoalsSaved] = useState(false);

  const [retroDays, setRetroDays] = useState("3");
  const [retroBusy, setRetroBusy] = useState(false);
  const [retroResults, setRetroResults] = useState<
    Array<{ date: string; calories: number; burned: number; netCalories: number }> | null
  >(null);

  useEffect(() => {
    if (!user) return;
    getUserGoals(user.uid).then((g) => {
      setCalorieGoal(String(g.calorieGoal));
      setProteinGoal(String(g.proteinGoal));
      setStepGoal(String(g.stepGoal ?? 10000));
      setNetFactor(String(g.netCalorieBurnFactor ?? 50));
    });
  }, [user]);

  async function saveGoals() {
    if (!user) return;
    setGoalsBusy(true);
    setGoalsSaved(false);
    try {
      const ref = doc(db, "users", user.uid, "meta", "profile");
      await setDoc(
        ref,
        {
          calorieGoal: Number(calorieGoal) || 0,
          proteinGoal: Number(proteinGoal) || 0,
          stepGoal: Number(stepGoal) || 0,
          netCalorieBurnFactor: Math.min(100, Math.max(0, Number(netFactor) || 0)),
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      );
      setGoalsSaved(true);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setGoalsBusy(false);
    }
  }

  async function runRetro() {
    if (!user) return;
    setRetroBusy(true);
    setError(null);
    try {
      const days = Math.max(1, Math.min(366, Number(retroDays) || 3));
      const from = localDateKeyDaysAgo(days - 1);
      const to = localDateKey();
      const [mealDays, workouts] = await Promise.all([
        getMealDaysSince(user.uid, from, to),
        getWorkoutsSince(user.uid, from, to),
      ]);
      const burnedByDate = new Map<string, number>();
      for (const w of workouts) {
        burnedByDate.set(w.date, (burnedByDate.get(w.date) ?? 0) + (w.calories ?? 0));
      }
      const factor = Math.min(100, Math.max(0, Number(netFactor) || 0));
      const results = mealDays
        .filter((m) => m.entries.length > 0 || burnedByDate.has(m.date))
        .map((m) => {
          const calories = m.totals.calories;
          const burned = burnedByDate.get(m.date) ?? 0;
          return { date: m.date, calories, burned, netCalories: computeNetCalories(calories, burned, factor) };
        })
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      setRetroResults(results);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setRetroBusy(false);
    }
  }

  if (authLoading) {
    return (
      <main>
        <p style={{ color: "var(--muted)" }}>{t("loading")}</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main>
        <h1>{t("navProfile")}</h1>
        <p style={{ color: "var(--muted)" }}>{t("signInPrompt")}</p>
        <button onClick={() => signIn()}>{t("signInWithGoogle")}</button>
        {authError && (
          <p style={{ color: "#ff6b6b", fontSize: 13 }}>
            {authError === AUTH_REDIRECT_LOST ? t("authRedirectLost") : `${t("signInFailed")}: ${authError}`}
          </p>
        )}
      </main>
    );
  }

  return (
    <main>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1>{t("navProfile")}</h1>
        <button onClick={() => signOutUser()} style={{ background: "none", color: "var(--muted)" }}>
          {t("signOut")} ({user.displayName ?? user.email})
        </button>
      </div>

      <div className="card" style={{ marginTop: 16, display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0 }}>{t("goalsTitle")}</h2>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("calorieGoalLabel")}</span>
          <input
            type="number"
            value={calorieGoal}
            onChange={(e) => setCalorieGoal(e.target.value)}
            style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
          />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("proteinGoalLabel")}</span>
          <input
            type="number"
            value={proteinGoal}
            onChange={(e) => setProteinGoal(e.target.value)}
            style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
          />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("stepsGoalLabel")}</span>
          <input
            type="number"
            value={stepGoal}
            onChange={(e) => setStepGoal(e.target.value)}
            style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
          />
        </label>
        <label style={{ display: "grid", gap: 4 }} title={t("netCalorieFactorExample")}>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("netCalorieFactorLabel")}</span>
          <input
            type="number"
            min={0}
            max={100}
            value={netFactor}
            onChange={(e) => setNetFactor(e.target.value)}
            style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)", maxWidth: 100 }}
          />
          <span style={{ color: "var(--muted)", fontSize: 12 }}>{t("netCalorieFactorExample")}</span>
        </label>

        <div style={{ display: "grid", gap: 8, borderTop: "0.5px solid var(--border)", paddingTop: 8 }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>{t("netCalorieFactorTitle")}</h3>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("retroDaysLabel")}</span>
            <input
              type="number"
              min={1}
              max={366}
              value={retroDays}
              onChange={(e) => setRetroDays(e.target.value)}
              style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)", width: 80 }}
            />
            <button onClick={runRetro} disabled={retroBusy}>
              {retroBusy ? t("working") : t("runRetro")}
            </button>
          </label>
          {retroResults && (
            retroResults.length === 0 ? (
              <p style={{ color: "var(--muted)" }}>{t("retroNoData")}</p>
            ) : (
              <div style={{ display: "grid", gap: 4 }}>
                {retroResults.map((r) => (
                  <div
                    key={r.date}
                    style={{ display: "flex", justifyContent: "space-between", fontSize: 13, borderTop: "0.5px solid var(--border)", padding: "6px 0" }}
                  >
                    <bdi dir="ltr">{r.date}</bdi>
                    <bdi dir="ltr" style={{ color: "var(--muted)" }}>
                      {Math.round(r.calories)} − ({Math.round(r.burned)} × {netFactor}%) ={" "}
                      <strong style={{ color: "var(--net)" }}>{Math.round(r.netCalories)} kcal</strong>
                    </bdi>
                  </div>
                ))}
              </div>
            )
          )}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={saveGoals} disabled={goalsBusy}>
            {goalsBusy ? t("working") : t("saveGoals")}
          </button>
          <Link href="/onboarding" style={{ color: "var(--protein)", fontSize: 13 }}>
            {t("recalculateGoals")}
          </Link>
        </div>
        {goalsSaved && <p style={{ color: "var(--burned)" }}>{t("saved")}</p>}
      </div>

      {error && <p style={{ color: "#ff6b6b" }}>{error}</p>}

      {isAdmin(user.uid) && (
        <div className="card" style={{ marginTop: 16 }}>
          <Link href="/admin" style={{ color: "var(--protein)" }}>
            {t("adminSettings")} {forwardArrow}
          </Link>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <p style={{ color: "var(--muted)", margin: 0 }}>{t("comingLater")}</p>
      </div>
    </main>
  );
}

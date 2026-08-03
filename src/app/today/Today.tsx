"use client";

/**
 * Today dashboard: 4 metric cards, meals table (+ inline add-meal form —
 * this becomes the chat FAB's "log a meal" mode in a later phase), and a
 * workouts section synced from Apple Health via Health Auto Export.
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import { auth } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/useAuth";
import { useI18n } from "@/lib/i18n/useI18n";
import {
  getFrequentMeals,
  getFrequentWorkouts,
  getMealDay,
  getStepsForDate,
  getWorkoutsForDate,
  localDateKey,
} from "@/lib/dashboard/queries";
import type { FrequentMeal, FrequentWorkout } from "@/lib/dashboard/queries";
import { getUserGoals } from "@/lib/profile/queries";
import { computeNetCalories } from "@/lib/goals/netCalories";
import type { DailySteps, MealDay, UserProfile, Workout } from "@/lib/types";

/** One of the app's 4 fixed accents — each has a matching `--{tone}-bg` tint. */
type MetricTone = "calories" | "protein" | "burned" | "net";

function MetricCard({
  label,
  value,
  goal,
  sub,
  tone,
}: {
  label: string;
  value: number;
  goal?: number;
  sub: React.ReactNode;
  tone: MetricTone;
}) {
  const ratio = goal ? value / goal : undefined;
  const pct = ratio != null ? Math.min(100, Math.round(ratio * 100)) : undefined;
  const overflow = ratio != null && ratio > 1;
  const colorVar = `var(--${tone})`;

  return (
    <div className="card" style={{ background: `var(--${tone}-bg)`, border: "none" }}>
      <div className="metric-label" style={{ color: colorVar }}>
        {label}
      </div>
      <div className="metric-value" style={{ color: colorVar }}>
        {Math.round(value)}
      </div>
      {/* Only the individual number/unit runs are bdi-isolated (at each call
          site) — wrapping the whole line in one <bdi dir="ltr"> would also
          reorder the Hebrew words mixed in with them (e.g. "goal" / "deficit"),
          since it treats the entire string as a single LTR run. */}
      <div style={{ color: colorVar, fontSize: 13, opacity: 0.85 }}>{sub}</div>
      {pct != null && (
        <div className="progress-track" style={{ background: "rgba(255,255,255,0.55)" }}>
          <div
            className="progress-fill"
            style={{ width: `${pct}%`, background: colorVar, opacity: overflow ? 1 : 0.85 }}
          />
        </div>
      )}
    </div>
  );
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function formatPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}/km`;
}

export default function Today() {
  const { user, loading: authLoading, authError, signIn } = useAuth();
  const { t, lang } = useI18n();

  const [mealDay, setMealDay] = useState<MealDay | null>(null);
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [steps, setSteps] = useState<DailySteps | null>(null);
  const [goals, setGoals] = useState<
    Pick<UserProfile, "calorieGoal" | "proteinGoal" | "netCalorieBurnFactor" | "stepGoal">
  >({
    calorieGoal: 1950,
    proteinGoal: 145,
    netCalorieBurnFactor: 50,
    stepGoal: 8000,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [manualCalories, setManualCalories] = useState("");
  const [manualProtein, setManualProtein] = useState("");
  const [busy, setBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [workoutText, setWorkoutText] = useState("");
  const [workoutFile, setWorkoutFile] = useState<File | null>(null);
  const [workoutBusy, setWorkoutBusy] = useState(false);

  const [editingWorkoutId, setEditingWorkoutId] = useState<string | null>(null);
  const [editWorkoutType, setEditWorkoutType] = useState("");
  const [editWorkoutDurationMin, setEditWorkoutDurationMin] = useState("");
  const [editWorkoutDistanceKm, setEditWorkoutDistanceKm] = useState("");
  const [editWorkoutCalories, setEditWorkoutCalories] = useState("");
  const [editWorkoutElevation, setEditWorkoutElevation] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCalories, setEditCalories] = useState("");
  const [editProtein, setEditProtein] = useState("");

  const [stepsText, setStepsText] = useState("");
  const [stepsFile, setStepsFile] = useState<File | null>(null);
  const [stepsBusy, setStepsBusy] = useState(false);

  const [frequentMeals, setFrequentMeals] = useState<FrequentMeal[]>([]);
  const [pickedMeal, setPickedMeal] = useState("");
  const [pickerGrams, setPickerGrams] = useState("");
  const [pickerCalories, setPickerCalories] = useState("");
  const [pickerProtein, setPickerProtein] = useState("");
  const [pickerMealBusy, setPickerMealBusy] = useState(false);

  const [frequentWorkouts, setFrequentWorkouts] = useState<FrequentWorkout[]>([]);
  const [pickedWorkout, setPickedWorkout] = useState("");
  const [pickerDurationMin, setPickerDurationMin] = useState("");
  const [pickerDistanceKm, setPickerDistanceKm] = useState("");
  const [pickerWorkoutCalories, setPickerWorkoutCalories] = useState("");
  const [pickerWorkoutBusy, setPickerWorkoutBusy] = useState(false);

  // Split from `load` so post-edit refreshes (after logging/deleting/editing
  // a meal or workout) don't flip the whole page back to the "Loading…"
  // placeholder — that's the "page refreshes" flicker. Only the very first
  // load (on mount) shows that placeholder; every refresh after just swaps
  // the data in place while the existing content stays mounted.
  const refresh = useCallback(async (uid: string) => {
    setError(null);
    try {
      const date = localDateKey();
      const [day, w, s, g, fm, fw] = await Promise.all([
        getMealDay(uid, date),
        getWorkoutsForDate(uid, date),
        getStepsForDate(uid, date),
        getUserGoals(uid),
        getFrequentMeals(uid),
        getFrequentWorkouts(uid),
      ]);
      setMealDay(day);
      setWorkouts(w);
      setSteps(s);
      setGoals(g);
      setFrequentMeals(fm);
      setFrequentWorkouts(fw);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  }, []);

  const load = useCallback(
    async (uid: string) => {
      setLoading(true);
      await refresh(uid);
      setLoading(false);
    },
    [refresh],
  );

  useEffect(() => {
    if (user) load(user.uid);
  }, [user, load]);

  async function submitMeal(e: React.FormEvent | React.KeyboardEvent) {
    e.preventDefault();
    const submittedText = text;
    const submittedFile = file;
    const submittedCalories = manualCalories;
    const submittedProtein = manualProtein;
    // Clear immediately — the box shouldn't still show the question while
    // we're checking it or waiting on the response (see the chat panel's
    // same pattern in ChatPanel.tsx).
    setText("");
    setFile(null);
    setManualCalories("");
    setManualProtein("");
    setBusy(true);
    setError(null);
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) throw new Error("Not signed in");
      const idToken = await currentUser.getIdToken();

      let imageUrl: string | undefined;
      if (submittedFile) {
        const { uploadNutritionImage } = await import("@/lib/firebase/uploadImage");
        imageUrl = await uploadNutritionImage(currentUser.uid, submittedFile);
      }

      const res = await fetch("/api/nutrition", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          text: submittedText || undefined,
          imageUrl,
          date: localDateKey(),
          lang,
          overrideCalories: submittedCalories ? Number(submittedCalories) : undefined,
          overrideProtein: submittedProtein ? Number(submittedProtein) : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      if (data.flagged) {
        setError(data.message);
        return;
      }

      await refresh(currentUser.uid);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      setText(submittedText);
      setFile(submittedFile);
      setManualCalories(submittedCalories);
      setManualProtein(submittedProtein);
    } finally {
      setBusy(false);
    }
  }

  function selectFrequentMeal(name: string) {
    setPickedMeal(name);
    const m = frequentMeals.find((f) => f.name === name);
    setPickerGrams(m?.avgGrams != null ? String(m.avgGrams) : "");
    setPickerCalories(m ? String(m.avgCalories) : "");
    setPickerProtein(m ? String(m.avgProtein) : "");
  }

  async function submitPickedMeal(e: React.FormEvent) {
    e.preventDefault();
    if (!pickedMeal) return;
    setPickerMealBusy(true);
    setError(null);
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) throw new Error("Not signed in");
      const idToken = await currentUser.getIdToken();
      const res = await fetch("/api/nutrition", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          parsed: {
            items: [
              {
                description: pickedMeal,
                calories: Number(pickerCalories) || 0,
                protein: Number(pickerProtein) || 0,
                grams: pickerGrams ? Number(pickerGrams) : undefined,
              },
            ],
          },
          date: localDateKey(),
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
      setPickedMeal("");
      setPickerGrams("");
      setPickerCalories("");
      setPickerProtein("");
      await refresh(currentUser.uid);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setPickerMealBusy(false);
    }
  }

  function selectFrequentWorkout(type: string) {
    setPickedWorkout(type);
    const w = frequentWorkouts.find((f) => f.type === type);
    setPickerDurationMin(w ? String(Math.round(w.avgDurationSec / 60)) : "");
    setPickerDistanceKm(w?.avgDistanceMeters != null ? (w.avgDistanceMeters / 1000).toFixed(1) : "");
    setPickerWorkoutCalories(w?.avgCalories != null ? String(w.avgCalories) : "");
  }

  async function submitPickedWorkout(e: React.FormEvent) {
    e.preventDefault();
    if (!pickedWorkout) return;
    setPickerWorkoutBusy(true);
    setError(null);
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) throw new Error("Not signed in");
      const idToken = await currentUser.getIdToken();
      const res = await fetch("/api/workouts", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          parsed: {
            type: pickedWorkout,
            durationSec: Math.round((Number(pickerDurationMin) || 0) * 60),
            distanceMeters: pickerDistanceKm ? Math.round(Number(pickerDistanceKm) * 1000) : undefined,
            calories: pickerWorkoutCalories ? Number(pickerWorkoutCalories) : undefined,
          },
          date: localDateKey(),
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
      setPickedWorkout("");
      setPickerDurationMin("");
      setPickerDistanceKm("");
      setPickerWorkoutCalories("");
      await refresh(currentUser.uid);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setPickerWorkoutBusy(false);
    }
  }

  async function deleteMeal(entryId: string) {
    const currentUser = auth.currentUser;
    if (!currentUser || !window.confirm(t("deleteMealConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch("/api/nutrition", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ date: localDateKey(), entryId }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      await refresh(currentUser.uid);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  function startEditMeal(entryId: string, calories: number, protein: number) {
    setEditingId(entryId);
    setEditCalories(String(Math.round(calories)));
    setEditProtein(String(Math.round(protein)));
  }

  async function saveMealEdit(entryId: string) {
    const currentUser = auth.currentUser;
    if (!currentUser) return;
    setBusy(true);
    setError(null);
    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch("/api/nutrition", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          date: localDateKey(),
          entryId,
          changes: { calories: Number(editCalories) || 0, protein: Number(editProtein) || 0 },
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      setEditingId(null);
      await refresh(currentUser.uid);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  async function submitWorkout(e: React.FormEvent | React.KeyboardEvent) {
    e.preventDefault();
    const submittedText = workoutText;
    const submittedFile = workoutFile;
    setWorkoutText("");
    setWorkoutFile(null);
    setWorkoutBusy(true);
    setError(null);
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) throw new Error("Not signed in");
      const idToken = await currentUser.getIdToken();

      let imageUrl: string | undefined;
      if (submittedFile) {
        const { uploadWorkoutImage } = await import("@/lib/firebase/uploadImage");
        imageUrl = await uploadWorkoutImage(currentUser.uid, submittedFile);
      }

      const res = await fetch("/api/workouts", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ text: submittedText || undefined, imageUrl, date: localDateKey(), lang }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      if (data.flagged) {
        setError(data.message);
        return;
      }

      await refresh(currentUser.uid);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      setWorkoutText(submittedText);
      setWorkoutFile(submittedFile);
    } finally {
      setWorkoutBusy(false);
    }
  }

  async function deleteWorkout(id: string) {
    const currentUser = auth.currentUser;
    if (!currentUser || !window.confirm(t("deleteWorkoutConfirm"))) return;
    setWorkoutBusy(true);
    setError(null);
    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch("/api/workouts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      await refresh(currentUser.uid);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setWorkoutBusy(false);
    }
  }

  function startEditWorkout(w: Workout) {
    setEditingWorkoutId(w.id);
    setEditWorkoutType(w.type);
    setEditWorkoutDurationMin(String(Math.round(w.duration / 60)));
    setEditWorkoutDistanceKm(w.distance != null ? (w.distance / 1000).toFixed(2) : "");
    setEditWorkoutCalories(w.calories != null ? String(Math.round(w.calories)) : "");
    setEditWorkoutElevation(w.elevationGain != null ? String(Math.round(w.elevationGain)) : "");
  }

  async function saveWorkoutEdit(id: string) {
    const currentUser = auth.currentUser;
    if (!currentUser) return;
    setWorkoutBusy(true);
    setError(null);
    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch("/api/workouts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          id,
          changes: {
            type: editWorkoutType.trim() || undefined,
            duration: Math.round((Number(editWorkoutDurationMin) || 0) * 60),
            distance: editWorkoutDistanceKm ? Math.round(Number(editWorkoutDistanceKm) * 1000) : undefined,
            calories: editWorkoutCalories ? Number(editWorkoutCalories) : undefined,
            elevationGain: editWorkoutElevation ? Number(editWorkoutElevation) : undefined,
          },
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      setEditingWorkoutId(null);
      await refresh(currentUser.uid);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setWorkoutBusy(false);
    }
  }

  async function submitSteps(e: React.FormEvent | React.KeyboardEvent) {
    e.preventDefault();
    const submittedText = stepsText;
    const submittedFile = stepsFile;
    setStepsText("");
    setStepsFile(null);
    setStepsBusy(true);
    setError(null);
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) throw new Error("Not signed in");
      const idToken = await currentUser.getIdToken();

      let imageUrl: string | undefined;
      if (submittedFile) {
        const { uploadStepsImage } = await import("@/lib/firebase/uploadImage");
        imageUrl = await uploadStepsImage(currentUser.uid, submittedFile);
      }

      // A pure number typed in ("8500") skips the parser entirely — no need
      // to round-trip a plain integer through an OpenAI call.
      const asNumber = Number(submittedText);
      const isPlainNumber = submittedText.trim() !== "" && Number.isFinite(asNumber) && !imageUrl;

      const res = await fetch("/api/steps", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          text: isPlainNumber ? undefined : submittedText || undefined,
          steps: isPlainNumber ? asNumber : undefined,
          imageUrl,
          date: localDateKey(),
          lang,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      if (data.flagged) {
        setError(data.message);
        return;
      }

      await refresh(currentUser.uid);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      setStepsText(submittedText);
      setStepsFile(submittedFile);
    } finally {
      setStepsBusy(false);
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
        <h1>{t("today")}</h1>
        <p style={{ color: "var(--muted)" }}>{t("signInPrompt")}</p>
        <button onClick={() => signIn()}>{t("signInWithGoogle")}</button>
        {authError && <p style={{ color: "#ff6b6b", fontSize: 13 }}>{t("signInFailed")}: {authError}</p>}
      </main>
    );
  }

  const totals = mealDay?.totals ?? { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const burned = workouts.reduce((sum, w) => sum + (w.calories ?? 0), 0);
  const net = computeNetCalories(totals.calories, burned, goals.netCalorieBurnFactor ?? 50);
  const lastSynced = workouts
    .map((w) => w.syncedAt)
    .sort()
    .at(-1);

  return (
    <main>
      <h1>{t("today")}</h1>

      {error && <p style={{ color: "#ff6b6b" }}>{error}</p>}

      {loading ? (
        <p style={{ color: "var(--muted)" }}>{t("loading")}</p>
      ) : (
        <>
          <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <MetricCard
              label={t("calories")}
              value={totals.calories}
              goal={goals.calorieGoal}
              sub={
                <>
                  <bdi dir="ltr">
                    {Math.round(totals.calories)} / {goals.calorieGoal}
                  </bdi>{" "}
                  {t("goal")} ·{" "}
                  <bdi dir="ltr">{Math.max(0, Math.round(goals.calorieGoal - totals.calories))}</bdi>{" "}
                  {t("remaining")}
                </>
              }
              tone="calories"
            />
            <MetricCard
              label={t("protein")}
              value={totals.protein}
              goal={goals.proteinGoal}
              sub={
                <>
                  <bdi dir="ltr">
                    {Math.round(totals.protein)}
                    {t("unitG")} / {goals.proteinGoal}
                    {t("unitG")}
                  </bdi>{" "}
                  · {totals.protein >= goals.proteinGoal ? t("surplus") : t("deficit")}{" "}
                  <bdi dir="ltr">
                    {Math.abs(Math.round(totals.protein - goals.proteinGoal))}
                    {t("unitG")}
                  </bdi>
                </>
              }
              tone="protein"
            />
            <MetricCard
              label={t("burned")}
              value={burned}
              sub={<bdi dir="ltr">{Math.round(burned)} kcal</bdi>}
              tone="burned"
            />
            <MetricCard
              label={t("net")}
              value={net}
              goal={goals.calorieGoal}
              sub={
                <>
                  <bdi dir="ltr">
                    {Math.round(totals.calories)} − ({Math.round(burned)} × {goals.netCalorieBurnFactor ?? 50}%)
                  </bdi>{" "}
                  · {net <= goals.calorieGoal ? t("deficit") : t("surplus")}{" "}
                  <bdi dir="ltr">{Math.abs(Math.round(net - goals.calorieGoal))}</bdi>
                </>
              }
              tone="net"
            />
          </section>

          <section style={{ marginTop: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <h2 style={{ margin: 0 }}>{t("meals")}</h2>
            </div>

            {frequentMeals.length > 0 && (
              <form onSubmit={submitPickedMeal} className="card" style={{ marginTop: 8, display: "grid", gap: 8 }}>
                <select
                  value={pickedMeal}
                  onChange={(e) => selectFrequentMeal(e.target.value)}
                  style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
                >
                  <option value="">{t("pickFrequentMeal")}</option>
                  {frequentMeals.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name} ({m.count}×, ~{m.avgCalories} kcal)
                    </option>
                  ))}
                </select>
                {pickedMeal && (
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      type="number"
                      inputMode="numeric"
                      value={pickerGrams}
                      onChange={(e) => setPickerGrams(e.target.value)}
                      placeholder={t("gramsPlaceholder")}
                      style={{ flex: 1, padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
                    />
                    <input
                      type="number"
                      inputMode="numeric"
                      value={pickerCalories}
                      onChange={(e) => setPickerCalories(e.target.value)}
                      placeholder={t("manualCaloriesPlaceholder")}
                      style={{ flex: 1, padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
                    />
                    <input
                      type="number"
                      inputMode="numeric"
                      value={pickerProtein}
                      onChange={(e) => setPickerProtein(e.target.value)}
                      placeholder={t("manualProteinPlaceholder")}
                      style={{ flex: 1, padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
                    />
                  </div>
                )}
                <button type="submit" disabled={!pickedMeal || pickerMealBusy}>
                  {pickerMealBusy ? t("logging") : t("logIt")}
                </button>
              </form>
            )}

            <form onSubmit={submitMeal} className="card" style={{ marginTop: 8, display: "grid", gap: 8 }}>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && (text || file) && !busy) {
                    submitMeal(e);
                  }
                }}
                placeholder={t("addMealPlaceholder")}
                rows={2}
                style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
              />
              <label
                title={t("photoUploadHint")}
                style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}
              >
                <span
                  style={{
                    border: "0.5px solid var(--border)",
                    borderRadius: 8,
                    padding: "8px 14px",
                    background: "var(--panel)",
                  }}
                >
                  📷 {t("chooseFile")}
                </span>
                <span style={{ color: "var(--muted)", fontSize: 13 }}>{file?.name}</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  style={{ display: "none" }}
                />
              </label>
              <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>{t("photoUploadHint")}</p>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="number"
                  inputMode="numeric"
                  value={manualCalories}
                  onChange={(e) => setManualCalories(e.target.value)}
                  placeholder={t("manualCaloriesPlaceholder")}
                  style={{ flex: 1, padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
                />
                <input
                  type="number"
                  inputMode="numeric"
                  value={manualProtein}
                  onChange={(e) => setManualProtein(e.target.value)}
                  placeholder={t("manualProteinPlaceholder")}
                  style={{ flex: 1, padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
                />
              </div>
              <button type="submit" disabled={busy || (!text && !file)}>
                {busy ? t("logging") : t("logIt")}
              </button>
            </form>

            <div className="card" style={{ marginTop: 8, padding: "4px 12px", overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ color: "var(--muted)", textAlign: "start", fontSize: 13 }}>
                  <th style={{ padding: "12px 10px" }}>{t("time")}</th>
                  <th style={{ padding: "12px 10px" }}>{t("meal")}</th>
                  <th style={{ padding: "12px 10px", textAlign: "center" }}>{t("calories")}</th>
                  <th style={{ padding: "12px 10px", textAlign: "center" }}>
                    {t("protein")} (<bdi dir="ltr">{t("unitGramHeader")}</bdi>)
                  </th>
                  <th style={{ padding: "12px 10px" }} />
                </tr>
              </thead>
              <tbody>
                {(mealDay?.entries ?? []).map((entry) => (
                  <Fragment key={entry.id}>
                    <tr
                      onClick={() => editingId !== entry.id && setExpandedId(expandedId === entry.id ? null : entry.id)}
                      style={{ borderTop: "0.5px solid var(--border)", cursor: editingId === entry.id ? "default" : "pointer" }}
                    >
                      <td style={{ padding: "12px 10px", color: "var(--muted)" }}>
                        <bdi dir="ltr">
                          {new Date(entry.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </bdi>
                      </td>
                      <td style={{ padding: "12px 10px" }}>{entry.name}</td>
                      {editingId === entry.id ? (
                        <>
                          <td style={{ padding: "12px 10px", textAlign: "center" }}>
                            <input
                              type="number"
                              value={editCalories}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => setEditCalories(e.target.value)}
                              style={{ width: 64, padding: 4, borderRadius: 6, border: "0.5px solid var(--border)" }}
                            />
                          </td>
                          <td style={{ padding: "12px 10px", textAlign: "center" }}>
                            <input
                              type="number"
                              value={editProtein}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => setEditProtein(e.target.value)}
                              style={{ width: 56, padding: 4, borderRadius: 6, border: "0.5px solid var(--border)" }}
                            />
                          </td>
                        </>
                      ) : (
                        <>
                          <td style={{ padding: "12px 10px", textAlign: "center" }}>
                            <bdi dir="ltr">{Math.round(entry.calories)}</bdi>
                          </td>
                          <td style={{ padding: "12px 10px", textAlign: "center" }}>
                            <bdi dir="ltr">{Math.round(entry.protein)}</bdi>
                          </td>
                        </>
                      )}
                      <td style={{ padding: "12px 10px", whiteSpace: "nowrap" }}>
                        {editingId === entry.id ? (
                          <>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                saveMealEdit(entry.id);
                              }}
                              disabled={busy}
                              style={{ border: "none", background: "none", color: "var(--protein)", padding: 6 }}
                              aria-label={t("save")}
                            >
                              ✓
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingId(null);
                              }}
                              disabled={busy}
                              style={{ border: "none", background: "none", color: "var(--muted)", padding: 6 }}
                              aria-label={t("close")}
                            >
                              ✕
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                startEditMeal(entry.id, entry.calories, entry.protein);
                              }}
                              disabled={busy}
                              style={{ border: "none", background: "none", padding: 6 }}
                              aria-label={t("edit")}
                            >
                              ✏️
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteMeal(entry.id);
                              }}
                              disabled={busy}
                              style={{ border: "none", background: "none", color: "var(--calories)", padding: 6 }}
                              aria-label={t("deleteMeal")}
                            >
                              ✕
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                    {expandedId === entry.id && (
                      <tr>
                        <td colSpan={5} style={{ padding: "0 10px 12px", color: "var(--muted)", fontSize: 13 }}>
                          <bdi dir="ltr">
                            {entry.carbs != null && `${t("carbs")} ${Math.round(entry.carbs)}${t("unitG")} · `}
                            {entry.fat != null && `${t("fat")} ${Math.round(entry.fat)}${t("unitG")} · `}
                            {entry.fiber != null && `${t("fiber")} ${Math.round(entry.fiber)}${t("unitG")} · `}
                            {entry.confidence != null && `${Math.round(entry.confidence * 100)}% ${t("confidence")}`}
                          </bdi>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: "0.5px solid var(--border)", fontWeight: 700 }}>
                  <td style={{ padding: "12px 10px" }} colSpan={2}>
                    {t("total")}
                  </td>
                  <td style={{ padding: "12px 10px", textAlign: "center" }}>
                    <bdi dir="ltr">{Math.round(totals.calories)}</bdi>
                  </td>
                  <td style={{ padding: "12px 10px", textAlign: "center" }}>
                    <bdi dir="ltr">{Math.round(totals.protein)}</bdi>
                  </td>
                  <td style={{ padding: "12px 10px" }} />
                </tr>
              </tfoot>
            </table>
            </div>
          </section>

          <section style={{ marginTop: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <h2 style={{ margin: 0 }}>{t("workouts")}</h2>
              <button onClick={() => user && refresh(user.uid)}>{t("refresh")}</button>
            </div>
            {lastSynced && (
              <p style={{ color: "var(--muted)", fontSize: 13 }}>
                {t("lastSynced")}: {new Date(lastSynced).toLocaleString()}
              </p>
            )}
            {workouts.length === 0 ? (
              <p style={{ color: "var(--muted)" }}>{t("noWorkoutsToday")}</p>
            ) : (
              <div className="card" style={{ marginTop: 8, padding: "4px 12px", overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ color: "var(--muted)", textAlign: "start", fontSize: 13 }}>
                      <th style={{ padding: "12px 10px" }}>{t("colType")}</th>
                      <th style={{ padding: "12px 10px", textAlign: "center" }}>{t("colDuration")}</th>
                      <th style={{ padding: "12px 10px", textAlign: "center" }}>{t("colDistance")}</th>
                      <th style={{ padding: "12px 10px", textAlign: "center" }}>{t("colPace")}</th>
                      <th style={{ padding: "12px 10px", textAlign: "center" }}>{t("calories")}</th>
                      <th style={{ padding: "12px 10px", textAlign: "center" }}>{t("avgHr")}</th>
                      <th style={{ padding: "12px 10px", textAlign: "center" }}>{t("colElevation")}</th>
                      <th style={{ padding: "12px 10px" }}>{t("colSource")}</th>
                      <th style={{ padding: "12px 10px" }} />
                    </tr>
                  </thead>
                  <tbody>
                    {workouts.map((w) => {
                      const editing = editingWorkoutId === w.id;
                      return (
                        <tr key={w.id} style={{ borderTop: "0.5px solid var(--border)" }}>
                          <td style={{ padding: "12px 10px" }}>
                            {editing ? (
                              <input
                                value={editWorkoutType}
                                onChange={(e) => setEditWorkoutType(e.target.value)}
                                style={{ width: 90, padding: 4, borderRadius: 6, border: "0.5px solid var(--border)" }}
                              />
                            ) : (
                              w.type
                            )}
                          </td>
                          <td style={{ padding: "12px 10px", textAlign: "center" }}>
                            {editing ? (
                              <input
                                type="number"
                                value={editWorkoutDurationMin}
                                onChange={(e) => setEditWorkoutDurationMin(e.target.value)}
                                style={{ width: 56, padding: 4, borderRadius: 6, border: "0.5px solid var(--border)" }}
                              />
                            ) : (
                              <bdi dir="ltr">{formatDuration(w.duration)}</bdi>
                            )}
                          </td>
                          <td style={{ padding: "12px 10px", textAlign: "center" }}>
                            {editing ? (
                              <input
                                type="number"
                                value={editWorkoutDistanceKm}
                                onChange={(e) => setEditWorkoutDistanceKm(e.target.value)}
                                placeholder="km"
                                style={{ width: 56, padding: 4, borderRadius: 6, border: "0.5px solid var(--border)" }}
                              />
                            ) : w.distance != null ? (
                              <bdi dir="ltr">{(w.distance / 1000).toFixed(1)} km</bdi>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td style={{ padding: "12px 10px", textAlign: "center" }}>
                            {w.pace != null ? <bdi dir="ltr">{formatPace(w.pace)}</bdi> : "—"}
                          </td>
                          <td style={{ padding: "12px 10px", textAlign: "center" }}>
                            {editing ? (
                              <input
                                type="number"
                                value={editWorkoutCalories}
                                onChange={(e) => setEditWorkoutCalories(e.target.value)}
                                style={{ width: 56, padding: 4, borderRadius: 6, border: "0.5px solid var(--border)" }}
                              />
                            ) : w.calories != null ? (
                              <bdi dir="ltr">{Math.round(w.calories)}</bdi>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td style={{ padding: "12px 10px", textAlign: "center" }}>
                            {w.heartRate?.avg != null ? <bdi dir="ltr">{Math.round(w.heartRate.avg)}</bdi> : "—"}
                          </td>
                          <td style={{ padding: "12px 10px", textAlign: "center" }}>
                            {editing ? (
                              <input
                                type="number"
                                value={editWorkoutElevation}
                                onChange={(e) => setEditWorkoutElevation(e.target.value)}
                                placeholder="m"
                                style={{ width: 56, padding: 4, borderRadius: 6, border: "0.5px solid var(--border)" }}
                              />
                            ) : w.elevationGain != null ? (
                              <bdi dir="ltr">+{Math.round(w.elevationGain)}m</bdi>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td style={{ padding: "12px 10px", color: "var(--muted)", fontSize: 13 }}>
                            {w.source === "manual" ? t("manuallyLogged") : w.source}
                          </td>
                          <td style={{ padding: "12px 10px", whiteSpace: "nowrap" }}>
                            {editing ? (
                              <>
                                <button
                                  onClick={() => saveWorkoutEdit(w.id)}
                                  disabled={workoutBusy}
                                  style={{ border: "none", background: "none", color: "var(--protein)", padding: 6 }}
                                  aria-label={t("save")}
                                >
                                  ✓
                                </button>
                                <button
                                  onClick={() => setEditingWorkoutId(null)}
                                  disabled={workoutBusy}
                                  style={{ border: "none", background: "none", color: "var(--muted)", padding: 6 }}
                                  aria-label={t("close")}
                                >
                                  ✕
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  onClick={() => startEditWorkout(w)}
                                  disabled={workoutBusy}
                                  style={{ border: "none", background: "none", padding: 6 }}
                                  aria-label={t("edit")}
                                >
                                  ✏️
                                </button>
                                <button
                                  onClick={() => deleteWorkout(w.id)}
                                  disabled={workoutBusy}
                                  style={{ border: "none", background: "none", color: "var(--calories)", padding: 6 }}
                                  aria-label={t("deleteWorkout")}
                                >
                                  ✕
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {frequentWorkouts.length > 0 && (
              <form onSubmit={submitPickedWorkout} className="card" style={{ marginTop: 16, display: "grid", gap: 8 }}>
                <select
                  value={pickedWorkout}
                  onChange={(e) => selectFrequentWorkout(e.target.value)}
                  style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
                >
                  <option value="">{t("pickFrequentWorkout")}</option>
                  {frequentWorkouts.map((w) => (
                    <option key={w.type} value={w.type}>
                      {w.type} ({w.count}×, ~{Math.round(w.avgDurationSec / 60)} min)
                    </option>
                  ))}
                </select>
                {pickedWorkout && (
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      type="number"
                      inputMode="numeric"
                      value={pickerDurationMin}
                      onChange={(e) => setPickerDurationMin(e.target.value)}
                      placeholder={t("durationMinPlaceholder")}
                      style={{ flex: 1, padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
                    />
                    <input
                      type="number"
                      inputMode="numeric"
                      value={pickerDistanceKm}
                      onChange={(e) => setPickerDistanceKm(e.target.value)}
                      placeholder={t("distanceKmPlaceholder")}
                      style={{ flex: 1, padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
                    />
                    <input
                      type="number"
                      inputMode="numeric"
                      value={pickerWorkoutCalories}
                      onChange={(e) => setPickerWorkoutCalories(e.target.value)}
                      placeholder={t("manualCaloriesPlaceholder")}
                      style={{ flex: 1, padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
                    />
                  </div>
                )}
                <button type="submit" disabled={!pickedWorkout || pickerWorkoutBusy}>
                  {pickerWorkoutBusy ? t("logging") : t("logIt")}
                </button>
              </form>
            )}

            <h3 style={{ marginTop: 16, marginBottom: 0 }}>{t("logWorkout")}</h3>
            <form onSubmit={submitWorkout} className="card" style={{ marginTop: 8, display: "grid", gap: 8 }}>
              <textarea
                value={workoutText}
                onChange={(e) => setWorkoutText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && (workoutText || workoutFile) && !workoutBusy) {
                    submitWorkout(e);
                  }
                }}
                placeholder={t("workoutPlaceholder")}
                rows={2}
                style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
              />
              <label
                title={t("photoUploadHint")}
                style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}
              >
                <span
                  style={{
                    border: "0.5px solid var(--border)",
                    borderRadius: 8,
                    padding: "8px 14px",
                    background: "var(--panel)",
                  }}
                >
                  📷 {t("chooseFile")}
                </span>
                <span style={{ color: "var(--muted)", fontSize: 13 }}>{workoutFile?.name}</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => setWorkoutFile(e.target.files?.[0] ?? null)}
                  style={{ display: "none" }}
                />
              </label>
              <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>{t("photoUploadHint")}</p>
              <button type="submit" disabled={workoutBusy || (!workoutText && !workoutFile)}>
                {workoutBusy ? t("logging") : t("logIt")}
              </button>
            </form>
          </section>

          <section style={{ marginTop: 24 }}>
            <h2 style={{ margin: 0 }}>{t("steps")}</h2>
            <div className="card" style={{ background: "var(--burned-bg)", border: "none", marginTop: 8 }}>
              <div className="metric-label" style={{ color: "var(--burned)" }}>
                {t("steps")}
              </div>
              <div className="metric-value" style={{ color: "var(--burned)" }}>
                {steps?.steps ?? 0}
              </div>
              <div style={{ color: "var(--burned)", fontSize: 13, opacity: 0.85 }}>
                <bdi dir="ltr">
                  {steps?.steps ?? 0} / {goals.stepGoal ?? 8000}
                </bdi>{" "}
                {t("goal")}
              </div>
              <div className="progress-track" style={{ background: "rgba(255,255,255,0.55)" }}>
                <div
                  className="progress-fill"
                  style={{
                    width: `${Math.min(100, Math.round(((steps?.steps ?? 0) / (goals.stepGoal || 1)) * 100))}%`,
                    background: "var(--burned)",
                    opacity: 0.85,
                  }}
                />
              </div>
            </div>

            <form onSubmit={submitSteps} className="card" style={{ marginTop: 8, display: "grid", gap: 8 }}>
              <textarea
                value={stepsText}
                onChange={(e) => setStepsText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && (stepsText || stepsFile) && !stepsBusy) {
                    submitSteps(e);
                  }
                }}
                placeholder={t("stepsPlaceholder")}
                rows={1}
                style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
              />
              <label
                title={t("photoUploadHint")}
                style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}
              >
                <span
                  style={{
                    border: "0.5px solid var(--border)",
                    borderRadius: 8,
                    padding: "8px 14px",
                    background: "var(--panel)",
                  }}
                >
                  📷 {t("chooseFile")}
                </span>
                <span style={{ color: "var(--muted)", fontSize: 13 }}>{stepsFile?.name}</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => setStepsFile(e.target.files?.[0] ?? null)}
                  style={{ display: "none" }}
                />
              </label>
              <button type="submit" disabled={stepsBusy || (!stepsText && !stepsFile)}>
                {stepsBusy ? t("logging") : t("logSteps")}
              </button>
            </form>
          </section>
        </>
      )}
    </main>
  );
}

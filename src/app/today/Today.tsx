"use client";

/**
 * Today dashboard: 4 metric cards, meals table (+ inline add-meal form —
 * this becomes the chat FAB's "log a meal" mode in a later phase), and a
 * workouts section synced from Apple Health via Health Auto Export.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
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

/** One of Today's readout accents — each has a matching `--{tone}-bg` tint. */
type MetricTone = "calories" | "protein" | "burned" | "net" | "steps";

/**
 * The signature readout: an accent-keyed label, a big tabular number, a muted
 * sub-line, and (when there's a goal) a thin progress bar. `hero` gives the
 * lead metric a tinted background and a larger figure.
 *
 * Only the individual number/unit runs inside `sub` are bdi-isolated (at each
 * call site) — wrapping the whole line in one <bdi dir="ltr"> would also
 * reorder the Hebrew words mixed in with them (e.g. "goal" / "deficit").
 */
function MetricCard({
  label,
  value,
  goal,
  sub,
  tone,
  hero = false,
}: {
  label: string;
  value: number;
  goal?: number;
  sub: React.ReactNode;
  tone: MetricTone;
  hero?: boolean;
}) {
  const ratio = goal ? value / goal : undefined;
  const pct = ratio != null ? Math.min(100, Math.round(ratio * 100)) : undefined;
  const overflow = ratio != null && ratio > 1;
  const colorVar = `var(--${tone})`;

  return (
    <div
      className="card"
      style={hero ? { background: `var(--${tone}-bg)`, borderColor: "transparent" } : undefined}
    >
      <div className="readout">
        <div className="readout__label" style={{ color: colorVar }}>
          {label}
        </div>
        <div className={`readout__value${hero ? " readout__value--hero" : ""}`} style={{ color: colorVar }}>
          {Math.round(value)}
        </div>
        <div className="readout__sub">{sub}</div>
        {pct != null && (
          <div className="progress-track" style={hero ? { background: "rgba(255,255,255,0.6)" } : undefined}>
            <div
              className="progress-fill"
              style={{ width: `${pct}%`, background: colorVar, opacity: overflow ? 1 : 0.9 }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * API error responses include a "detail" alongside "error" for failures
 * from an upstream parse (e.g. parseNutrition/parseWorkout's own error
 * message) — dropping it left the "tap for details" dropdown showing only
 * the generic "Failed to parse nutrition" with nothing actually diagnostic
 * underneath.
 */
function apiErrorMessage(data: { error?: string; detail?: string }, fallback: string): string {
  const error = data.error ?? fallback;
  return data.detail ? `${error}: ${data.detail}` : error;
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

/** Inverse of formatPace's "M:SS" — returns seconds/km, or null if unparseable. */
function parsePaceToSecPerKm(text: string): number | null {
  const match = text.trim().match(/^(\d+):([0-5]?\d)$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
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
    stepGoal: 10000,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The error banner renders once, near the top of a long scrolling page —
  // an error from a form further down (e.g. the workout section) previously
  // just appeared off-screen with no visible feedback, reading as "nothing
  // happened" rather than as a failure.
  useEffect(() => {
    if (error) window.scrollTo({ top: 0, behavior: "smooth" });
  }, [error]);

  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  // Same thumbnail-preview treatment as the chat panel's photo attach — a
  // filename-only confirmation is easy to miss; a visible thumbnail isn't.
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setFilePreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setFilePreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const [manualCalories, setManualCalories] = useState("");
  const [manualProtein, setManualProtein] = useState("");
  const [busy, setBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [workoutText, setWorkoutText] = useState("");
  const [workoutFile, setWorkoutFile] = useState<File | null>(null);
  const [workoutBusy, setWorkoutBusy] = useState(false);
  const [workoutsRefreshBusy, setWorkoutsRefreshBusy] = useState(false);

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
  /** Per-100g USDA values for the picked meal name, used to auto-fill whichever of grams/calories/protein the user didn't type. */
  const [pickerPer100g, setPickerPer100g] = useState<{ caloriesPer100g: number; proteinPer100g: number } | null>(null);
  /** Unit-based amount ("1 date", "2 slices") for when the user knows how much they ate but not the gram weight — converted to grams via /api/nutrition/lookup's quantity estimate. */
  const [pickerQuantity, setPickerQuantity] = useState("");
  const [pickerQuantityBusy, setPickerQuantityBusy] = useState(false);

  const [frequentWorkouts, setFrequentWorkouts] = useState<FrequentWorkout[]>([]);
  const [pickedWorkout, setPickedWorkout] = useState("");
  const [pickerDurationMin, setPickerDurationMin] = useState("");
  const [pickerDistanceKm, setPickerDistanceKm] = useState("");
  const [pickerWorkoutCalories, setPickerWorkoutCalories] = useState("");
  /** "M:SS" per km — mirrors the app's existing pace display convention (see formatPace). */
  const [pickerPace, setPickerPace] = useState("");
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

  // Mobile Safari/PWA often keeps this page's JS alive in the background
  // instead of reloading it — reopening the app the next day previously
  // still showed the stale day loaded before it was backgrounded, since
  // nothing re-ran `refresh` (which recomputes "today" fresh each call).
  // Re-checking whenever the tab becomes visible/focused again covers both
  // the day-rollover case and general staleness from being away a while.
  useEffect(() => {
    if (!user) return;
    function onVisible() {
      if (document.visibilityState === "visible") refresh(user!.uid);
    }
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [user, refresh]);

  // Pull-to-refresh: only engages when already scrolled to the very top,
  // so it never fights normal scrolling further down the page.
  const PULL_THRESHOLD = 70;
  const pullStartYRef = useRef<number | null>(null);
  const pullDistanceRef = useRef(0);
  const [pullDistance, setPullDistance] = useState(0);
  const [pullRefreshing, setPullRefreshing] = useState(false);

  useEffect(() => {
    function onTouchStart(e: TouchEvent) {
      pullStartYRef.current = window.scrollY <= 0 ? e.touches[0].clientY : null;
    }
    function onTouchMove(e: TouchEvent) {
      if (pullStartYRef.current == null) return;
      const delta = e.touches[0].clientY - pullStartYRef.current;
      if (delta > 0 && window.scrollY <= 0) {
        const capped = Math.min(delta, 100);
        pullDistanceRef.current = capped;
        setPullDistance(capped);
        if (delta > 10 && e.cancelable) e.preventDefault();
      } else {
        pullStartYRef.current = null;
        pullDistanceRef.current = 0;
        setPullDistance(0);
      }
    }
    async function onTouchEnd() {
      const pulled = pullDistanceRef.current;
      pullStartYRef.current = null;
      pullDistanceRef.current = 0;
      if (pulled > PULL_THRESHOLD && user) {
        setPullRefreshing(true);
        setPullDistance(PULL_THRESHOLD);
        await refresh(user.uid);
        setPullRefreshing(false);
      }
      setPullDistance(0);
    }
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [user, refresh]);

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
      if (!res.ok) throw new Error(apiErrorMessage(data, res.statusText));
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

  async function selectFrequentMeal(name: string) {
    setPickedMeal(name);
    setPickerPer100g(null);
    setPickerQuantity("");
    const m = frequentMeals.find((f) => f.name === name);
    const hasHistory = !!m && (m.avgCalories > 0 || m.avgProtein > 0);
    setPickerGrams(m?.avgGrams != null ? String(m.avgGrams) : "");
    setPickerCalories(hasHistory ? String(m!.avgCalories) : "");
    setPickerProtein(hasHistory ? String(m!.avgProtein) : "");
    if (!name) return;

    // No logged history yet (e.g. first time picking "Edamame") means
    // avgCalories/avgProtein are 0 — look up USDA per-100g values so the
    // row isn't logged with zeroed-out nutrition, and so typing any one of
    // grams/calories/protein below can derive the other two.
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) return;
      const idToken = await currentUser.getIdToken();
      const res = await fetch("/api/nutrition/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ query: name }),
      });
      const data = await res.json().catch(() => ({}));
      const match = data.match as { caloriesPer100g: number; proteinPer100g: number } | null | undefined;
      if (!match) return;
      setPickerPer100g({ caloriesPer100g: match.caloriesPer100g, proteinPer100g: match.proteinPer100g });
      if (!hasHistory) {
        const grams = m?.avgGrams || 100;
        setPickerGrams(String(grams));
        setPickerCalories(String(Math.round((match.caloriesPer100g * grams) / 100)));
        setPickerProtein(String(Math.round(((match.proteinPer100g * grams) / 100) * 10) / 10));
      }
    } catch {
      // best-effort — manual entry still works without per-100g data
    }
  }

  /**
   * Lets the user say how much they ate in everyday units ("1 date", "2
   * slices") instead of grams — /api/nutrition/lookup estimates the gram
   * weight for that quantity of this food (via the model's general
   * knowledge of typical unit weights), then feeds it through the same
   * grams→calories/protein conversion as typing grams directly.
   */
  async function applyPickerQuantity() {
    if (!pickedMeal || !pickerQuantity.trim()) return;
    setPickerQuantityBusy(true);
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) return;
      const idToken = await currentUser.getIdToken();
      const res = await fetch("/api/nutrition/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ query: pickedMeal, quantity: pickerQuantity.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      const estimatedGrams = data.estimatedGrams as number | null | undefined;
      if (estimatedGrams != null) {
        onPickerGramsChange(String(Math.round(estimatedGrams)));
      }
    } catch {
      // best-effort — manual gram entry still works
    } finally {
      setPickerQuantityBusy(false);
    }
  }

  function onPickerGramsChange(value: string) {
    setPickerGrams(value);
    const grams = Number(value);
    if (!pickerPer100g || !value || Number.isNaN(grams)) return;
    setPickerCalories(String(Math.round((pickerPer100g.caloriesPer100g * grams) / 100)));
    setPickerProtein(String(Math.round(((pickerPer100g.proteinPer100g * grams) / 100) * 10) / 10));
  }

  function onPickerCaloriesChange(value: string) {
    setPickerCalories(value);
    const calories = Number(value);
    if (!pickerPer100g || !pickerPer100g.caloriesPer100g || !value || Number.isNaN(calories)) return;
    const grams = (calories / pickerPer100g.caloriesPer100g) * 100;
    setPickerGrams(String(Math.round(grams)));
    setPickerProtein(String(Math.round(((pickerPer100g.proteinPer100g * grams) / 100) * 10) / 10));
  }

  function onPickerProteinChange(value: string) {
    setPickerProtein(value);
    const protein = Number(value);
    if (!pickerPer100g || !pickerPer100g.proteinPer100g || !value || Number.isNaN(protein)) return;
    const grams = (protein / pickerPer100g.proteinPer100g) * 100;
    setPickerGrams(String(Math.round(grams)));
    setPickerCalories(String(Math.round((pickerPer100g.caloriesPer100g * grams) / 100)));
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
      if (!res.ok) throw new Error(apiErrorMessage(await res.json().catch(() => ({})), res.statusText));
      setPickedMeal("");
      setPickerGrams("");
      setPickerCalories("");
      setPickerProtein("");
      setPickerPer100g(null);
      setPickerQuantity("");
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
    setPickerDistanceKm(w?.avgDistanceMeters != null ? (w.avgDistanceMeters / 1000).toFixed(1) : "");
    setPickerWorkoutCalories(w?.avgCalories != null ? String(w.avgCalories) : "");
    if (w?.avgDistanceMeters && w.avgDurationSec) {
      setPickerPace(formatPace(w.avgDurationSec / (w.avgDistanceMeters / 1000)).replace("/km", ""));
      setPickerDurationMin("");
    } else {
      setPickerPace("");
      setPickerDurationMin(w ? String(Math.round(w.avgDurationSec / 60)) : "");
    }
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
      const distanceMeters = pickerDistanceKm ? Math.round(Number(pickerDistanceKm) * 1000) : undefined;
      const paceSecPerKm = parsePaceToSecPerKm(pickerPace);
      // Pace + distance determines duration directly when both are given —
      // more natural for a runner/walker than typing total duration by hand.
      const durationSec =
        distanceMeters && paceSecPerKm != null
          ? Math.round((distanceMeters / 1000) * paceSecPerKm)
          : Math.round((Number(pickerDurationMin) || 0) * 60);
      const res = await fetch("/api/workouts", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          parsed: {
            type: pickedWorkout,
            durationSec,
            distanceMeters,
            paceSecPerKm: paceSecPerKm ?? undefined,
            calories: pickerWorkoutCalories ? Number(pickerWorkoutCalories) : undefined,
          },
          date: localDateKey(),
        }),
      });
      if (!res.ok) throw new Error(apiErrorMessage(await res.json().catch(() => ({})), res.statusText));
      setPickedWorkout("");
      setPickerDurationMin("");
      setPickerDistanceKm("");
      setPickerWorkoutCalories("");
      setPickerPace("");
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
      if (!res.ok) throw new Error(apiErrorMessage(data, res.statusText));
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
      if (!res.ok) throw new Error(apiErrorMessage(data, res.statusText));
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
        <p style={{ color: "var(--muted)", marginTop: -8 }}>{t("signInPrompt")}</p>
        <button className="btn-primary" onClick={() => signIn()} style={{ marginTop: 8 }}>
          {t("signInWithGoogle")}
        </button>
        {authError && (
          <p style={{ color: "var(--danger)", fontSize: 13 }}>
            {t("signInFailed")}: {authError}
          </p>
        )}
      </main>
    );
  }

  const todayLabel = new Date().toLocaleDateString(lang === "he" ? "he-IL" : "en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const totals = mealDay?.totals ?? { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const burned = workouts.reduce((sum, w) => sum + (w.calories ?? 0), 0);
  const net = computeNetCalories(totals.calories, burned, goals.netCalorieBurnFactor ?? 50);
  const lastSynced = workouts
    .map((w) => w.syncedAt)
    .sort()
    .at(-1);

  return (
    <main>
      {(pullDistance > 0 || pullRefreshing) && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            gap: 6,
            height: pullRefreshing ? 36 : pullDistance,
            overflow: "hidden",
            color: "var(--muted)",
            fontSize: 12,
            transition: pullRefreshing ? "height 0.15s ease" : undefined,
          }}
        >
          <span
            aria-hidden
            style={{
              display: "inline-block",
              width: 12,
              height: 12,
              borderRadius: "50%",
              border: "2px solid currentColor",
              borderInlineEndColor: "transparent",
              animation: pullRefreshing ? "pull-refresh-spin 0.7s linear infinite" : undefined,
              transform: pullRefreshing ? undefined : `rotate(${Math.min(pullDistance / PULL_THRESHOLD, 1) * 180}deg)`,
            }}
          />
          {pullRefreshing ? t("refreshing") : pullDistance > PULL_THRESHOLD ? t("releaseToRefresh") : t("pullToRefresh")}
        </div>
      )}
      <style>{`
        @keyframes pull-refresh-spin { to { transform: rotate(360deg); } }
      `}</style>

      <div style={{ marginBottom: 18 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--muted)",
          }}
        >
          <bdi>{todayLabel}</bdi>
        </div>
        <h1 style={{ margin: "2px 0 0" }}>{t("today")}</h1>
      </div>

      {error && (
        <details style={{ marginBottom: 12 }}>
          <summary style={{ color: "var(--danger)", cursor: "pointer" }}>{t("somethingWentWrong")}</summary>
          <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 4, whiteSpace: "pre-wrap" }}>{error}</p>
        </details>
      )}

      {loading ? (
        <p style={{ color: "var(--muted)" }}>{t("loading")}</p>
      ) : (
        <>
          <section>
            <MetricCard
              hero
              label={t("calories")}
              value={totals.calories}
              goal={goals.calorieGoal}
              sub={
                <>
                  <bdi dir="ltr">
                    {Math.round(totals.calories)} / {goals.calorieGoal} kcal
                  </bdi>{" "}
                  ·{" "}
                  <bdi dir="ltr">{Math.max(0, Math.round(goals.calorieGoal - totals.calories))}</bdi>{" "}
                  {t("remaining")}
                </>
              }
              tone="calories"
            />
            <div
              style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}
            >
            <MetricCard
              label={t("protein")}
              value={totals.protein}
              goal={goals.proteinGoal}
              sub={
                <>
                  <bdi dir="ltr">{Math.round(totals.protein)}</bdi> {t("unitG")} /{" "}
                  <bdi dir="ltr">{goals.proteinGoal}</bdi> {t("unitG")} ·{" "}
                  {totals.protein >= goals.proteinGoal ? t("surplus") : t("deficit")}{" "}
                  <bdi dir="ltr">{Math.abs(Math.round(totals.protein - goals.proteinGoal))}</bdi> {t("unitG")}
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
                  {net <= goals.calorieGoal ? t("deficit") : t("surplus")}{" "}
                  <bdi dir="ltr">{Math.abs(Math.round(net - goals.calorieGoal))}</bdi> {t("vsGoal")}
                </>
              }
              tone="net"
            />
            <MetricCard
              label={t("steps")}
              value={steps?.steps ?? 0}
              goal={goals.stepGoal ?? 10000}
              sub={
                <>
                  <bdi dir="ltr">
                    {steps?.steps ?? 0} / {goals.stepGoal ?? 10000}
                  </bdi>{" "}
                  {t("goal")}
                </>
              }
              tone="steps"
            />
            </div>
          </section>

          <section style={{ marginTop: 28 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
              <h2 style={{ margin: 0 }}>{t("meals")}</h2>
              <span style={{ fontSize: 13, color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
                <bdi dir="ltr">{Math.round(totals.calories)}</bdi> {t("calories")} ·{" "}
                <bdi dir="ltr">{Math.round(totals.protein)}</bdi> {t("unitG")} {t("protein")}
              </span>
            </div>

            <details className="disclosure" style={{ marginTop: 12 }}>
              <summary>{t("addMeal")}</summary>
              <div className="disclosure__body">
                {frequentMeals.length > 0 && (
                  <form onSubmit={submitPickedMeal} style={{ display: "grid", gap: 10 }}>
                    <div className="chip-row">
                      {frequentMeals.map((m) => (
                        <button
                          key={m.name}
                          type="button"
                          className={`chip${pickedMeal === m.name ? " chip--active" : ""}`}
                          onClick={() => selectFrequentMeal(pickedMeal === m.name ? "" : m.name)}
                        >
                          {m.name}
                        </button>
                      ))}
                    </div>
                    {pickedMeal && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        <input
                          type="text"
                          value={pickerQuantity}
                          onChange={(e) => setPickerQuantity(e.target.value)}
                          onBlur={applyPickerQuantity}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              applyPickerQuantity();
                            }
                          }}
                          placeholder={t("quantityPlaceholder")}
                          disabled={pickerQuantityBusy}
                          style={{ flex: "1 1 130px" }}
                        />
                        <input
                          type="number"
                          inputMode="numeric"
                          value={pickerGrams}
                          onChange={(e) => onPickerGramsChange(e.target.value)}
                          placeholder={t("gramsPlaceholder")}
                          style={{ flex: "1 1 130px" }}
                        />
                        <input
                          type="number"
                          inputMode="numeric"
                          value={pickerCalories}
                          onChange={(e) => onPickerCaloriesChange(e.target.value)}
                          placeholder={t("manualCaloriesPlaceholder")}
                          style={{ flex: "1 1 130px" }}
                        />
                        <input
                          type="number"
                          inputMode="numeric"
                          value={pickerProtein}
                          onChange={(e) => onPickerProteinChange(e.target.value)}
                          placeholder={t("manualProteinPlaceholder")}
                          style={{ flex: "1 1 130px" }}
                        />
                      </div>
                    )}
                    {pickedMeal && (
                      <button type="submit" className="btn-primary" disabled={pickerMealBusy}>
                        {pickerMealBusy ? t("logging") : t("logIt")}
                      </button>
                    )}
                  </form>
                )}

            <form onSubmit={submitMeal} style={{ display: "grid", gap: 8 }}>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && (text || file) && !busy) {
                    submitMeal(e);
                  }
                }}
                placeholder={file ? t("photoCaptionPlaceholder") : t("addMealPlaceholder")}
                rows={2}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <label title={t("photoUploadHint")} style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <span className="btn btn-sm">📷 {t("chooseFile")}</span>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    style={{ display: "none" }}
                  />
                </label>
                {file && filePreviewUrl && (
                  <div style={{ position: "relative", flexShrink: 0, width: 40, height: 40 }}>
                    <img
                      src={filePreviewUrl}
                      alt=""
                      style={{ width: 40, height: 40, borderRadius: 8, objectFit: "cover", border: "0.5px solid var(--border)", display: "block" }}
                    />
                    <button
                      type="button"
                      onClick={() => setFile(null)}
                      aria-label={t("removePhoto")}
                      title={t("removePhoto")}
                      style={{
                        position: "absolute",
                        top: -6,
                        insetInlineEnd: -6,
                        width: 16,
                        height: 16,
                        borderRadius: "50%",
                        border: "none",
                        background: "var(--danger)",
                        color: "#fff",
                        fontSize: 10,
                        lineHeight: 1,
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: 0,
                      }}
                    >
                      ×
                    </button>
                  </div>
                )}
              </div>
              <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>{t("photoUploadHint")}</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <input
                  type="number"
                  inputMode="numeric"
                  value={manualCalories}
                  onChange={(e) => setManualCalories(e.target.value)}
                  placeholder={t("manualCaloriesPlaceholder")}
                  style={{ flex: "1 1 130px", padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
                />
                <input
                  type="number"
                  inputMode="numeric"
                  value={manualProtein}
                  onChange={(e) => setManualProtein(e.target.value)}
                  placeholder={t("manualProteinPlaceholder")}
                  style={{ flex: "1 1 130px", padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
                />
              </div>
              <button type="submit" className="btn-primary" disabled={busy || (!text && !file)}>
                {busy ? t("logging") : t("logIt")}
              </button>
            </form>
              </div>
            </details>

            <div className="card desktop-table" style={{ marginTop: 12, padding: "4px 12px", overflowX: "auto" }}>
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
                            {entry.grams != null && `${Math.round(entry.grams)}${t("unitG")} ${t("gramsLabel")} · `}
                            {entry.carbs != null && `${t("carbs")} ${Math.round(entry.carbs)}${t("unitG")} · `}
                            {entry.fat != null && `${t("fat")} ${Math.round(entry.fat)}${t("unitG")} · `}
                            {entry.fiber != null && `${t("fiber")} ${Math.round(entry.fiber)}${t("unitG")} · `}
                            {entry.confidence != null && `${Math.round(entry.confidence * 100)}% ${t("confidence")}`}
                          </bdi>
                          {entry.ingredients && entry.ingredients.length > 0 && (
                            <div style={{ marginTop: 4 }}>
                              {t("ingredients")}: {entry.ingredients.join(", ")}
                            </div>
                          )}
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

            <div className="mobile-cards" style={{ marginTop: 8, gap: 8 }}>
              {(mealDay?.entries ?? []).map((entry) => {
                const editing = editingId === entry.id;
                const expanded = expandedId === entry.id;
                return (
                  <div key={entry.id} className="card" style={{ display: "grid", gap: 6 }}>
                    <div
                      onClick={() => !editing && setExpandedId(expanded ? null : entry.id)}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                        gap: 8,
                        cursor: editing ? "default" : "pointer",
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{entry.name}</div>
                        <div style={{ color: "var(--muted)", fontSize: 12 }}>
                          <bdi dir="ltr">
                            {new Date(entry.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </bdi>
                        </div>
                      </div>
                      <div style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
                        {editing ? (
                          <>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                saveMealEdit(entry.id);
                              }}
                              disabled={busy}
                              style={{ border: "none", background: "none", color: "var(--protein)", padding: 8 }}
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
                              style={{ border: "none", background: "none", color: "var(--muted)", padding: 8 }}
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
                              style={{ border: "none", background: "none", padding: 8 }}
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
                              style={{ border: "none", background: "none", color: "var(--calories)", padding: 8 }}
                              aria-label={t("deleteMeal")}
                            >
                              ✕
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    {editing ? (
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--muted)" }}>
                          {t("calories")}
                          <input
                            type="number"
                            value={editCalories}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setEditCalories(e.target.value)}
                            style={{ width: 64, padding: 4, borderRadius: 6, border: "0.5px solid var(--border)" }}
                          />
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--muted)" }}>
                          {t("protein")}
                          <input
                            type="number"
                            value={editProtein}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setEditProtein(e.target.value)}
                            style={{ width: 56, padding: 4, borderRadius: 6, border: "0.5px solid var(--border)" }}
                          />
                        </label>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 14, fontSize: 13, color: "var(--muted)" }}>
                        <span>
                          <bdi dir="ltr">{Math.round(entry.calories)}</bdi> {t("calories")}
                        </span>
                        <span>
                          <bdi dir="ltr">{Math.round(entry.protein)}</bdi>
                          {t("unitG")} {t("protein")}
                        </span>
                      </div>
                    )}
                    {expanded && (
                      <div style={{ color: "var(--muted)", fontSize: 13 }}>
                        <bdi dir="ltr">
                          {entry.grams != null && `${Math.round(entry.grams)}${t("unitG")} ${t("gramsLabel")} · `}
                          {entry.carbs != null && `${t("carbs")} ${Math.round(entry.carbs)}${t("unitG")} · `}
                          {entry.fat != null && `${t("fat")} ${Math.round(entry.fat)}${t("unitG")} · `}
                          {entry.fiber != null && `${t("fiber")} ${Math.round(entry.fiber)}${t("unitG")} · `}
                          {entry.confidence != null && `${Math.round(entry.confidence * 100)}% ${t("confidence")}`}
                        </bdi>
                        {entry.ingredients && entry.ingredients.length > 0 && (
                          <div style={{ marginTop: 4 }}>
                            {t("ingredients")}: {entry.ingredients.join(", ")}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {(mealDay?.entries?.length ?? 0) > 0 && (
                <div className="card" style={{ display: "flex", justifyContent: "space-between", fontWeight: 700 }}>
                  <span>{t("total")}</span>
                  <span>
                    <bdi dir="ltr">{Math.round(totals.calories)}</bdi> {t("calories")} ·{" "}
                    <bdi dir="ltr">{Math.round(totals.protein)}</bdi>
                    {t("unitG")} {t("protein")}
                  </span>
                </div>
              )}
            </div>
          </section>

          <section style={{ marginTop: 28 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <h2 style={{ margin: 0 }}>{t("workouts")}</h2>
              <button
                className="btn-sm btn-ghost"
                disabled={workoutsRefreshBusy}
                onClick={async () => {
                  if (!user) return;
                  setWorkoutsRefreshBusy(true);
                  try {
                    await refresh(user.uid);
                  } finally {
                    setWorkoutsRefreshBusy(false);
                  }
                }}
              >
                {workoutsRefreshBusy ? t("working") : t("refresh")}
              </button>
            </div>
            {lastSynced && (
              <p style={{ color: "var(--muted)", fontSize: 12, marginTop: 4 }}>
                {t("lastSynced")}: {new Date(lastSynced).toLocaleString()}
              </p>
            )}
            {workouts.length === 0 ? (
              <p style={{ color: "var(--muted)", marginTop: 8 }}>{t("noWorkoutsToday")}</p>
            ) : (
              <div className="card desktop-table" style={{ marginTop: 12, padding: "4px 12px", overflowX: "auto" }}>
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

            {workouts.length > 0 && (
              <div className="mobile-cards" style={{ marginTop: 8, gap: 8 }}>
                {workouts.map((w) => {
                  const editing = editingWorkoutId === w.id;
                  return (
                    <div key={w.id} className="card" style={{ display: "grid", gap: 6 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        {editing ? (
                          <input
                            value={editWorkoutType}
                            onChange={(e) => setEditWorkoutType(e.target.value)}
                            style={{ flex: 1, padding: 4, borderRadius: 6, border: "0.5px solid var(--border)" }}
                          />
                        ) : (
                          <strong>{w.type}</strong>
                        )}
                        <div style={{ whiteSpace: "nowrap" }}>
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
                        </div>
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px", fontSize: 13, color: "var(--muted)" }}>
                        <span>
                          {t("colDuration")}:{" "}
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
                        </span>
                        <span>
                          {t("colDistance")}:{" "}
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
                        </span>
                        {w.pace != null && (
                          <span>
                            {t("colPace")}: <bdi dir="ltr">{formatPace(w.pace)}</bdi>
                          </span>
                        )}
                        <span>
                          {t("calories")}:{" "}
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
                        </span>
                        {w.heartRate?.avg != null && (
                          <span>
                            {t("avgHr")}: <bdi dir="ltr">{Math.round(w.heartRate.avg)}</bdi>
                          </span>
                        )}
                        <span>
                          {t("colElevation")}:{" "}
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
                        </span>
                        <span>{w.source === "manual" ? t("manuallyLogged") : w.source}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <details className="disclosure" style={{ marginTop: 12 }}>
              <summary>{t("logWorkout")}</summary>
              <div className="disclosure__body">
                {frequentWorkouts.length > 0 && (
                  <form onSubmit={submitPickedWorkout} style={{ display: "grid", gap: 10 }}>
                    <div className="chip-row">
                      {frequentWorkouts.map((w) => (
                        <button
                          key={w.type}
                          type="button"
                          className={`chip${pickedWorkout === w.type ? " chip--active" : ""}`}
                          onClick={() => selectFrequentWorkout(pickedWorkout === w.type ? "" : w.type)}
                        >
                          {w.type}
                        </button>
                      ))}
                    </div>
                    {pickedWorkout && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        <input
                          type="number"
                          inputMode="numeric"
                          value={pickerDistanceKm}
                          onChange={(e) => setPickerDistanceKm(e.target.value)}
                          placeholder={t("distanceKmPlaceholder")}
                          style={{ flex: 1, minWidth: 90 }}
                        />
                        <input
                          value={pickerPace}
                          onChange={(e) => setPickerPace(e.target.value)}
                          placeholder={t("pacePlaceholder")}
                          style={{ flex: 1, minWidth: 90 }}
                        />
                        <input
                          type="number"
                          inputMode="numeric"
                          value={pickerWorkoutCalories}
                          onChange={(e) => setPickerWorkoutCalories(e.target.value)}
                          placeholder={t("manualCaloriesPlaceholder")}
                          style={{ flex: 1, minWidth: 90 }}
                        />
                        {!parsePaceToSecPerKm(pickerPace) && (
                          <input
                            type="number"
                            inputMode="numeric"
                            value={pickerDurationMin}
                            onChange={(e) => setPickerDurationMin(e.target.value)}
                            placeholder={t("durationMinPlaceholder")}
                            style={{ flex: 1, minWidth: 90 }}
                          />
                        )}
                      </div>
                    )}
                    {pickedWorkout && (
                      <button type="submit" className="btn-primary" disabled={pickerWorkoutBusy}>
                        {pickerWorkoutBusy ? t("logging") : t("logIt")}
                      </button>
                    )}
                  </form>
                )}

                <form onSubmit={submitWorkout} style={{ display: "grid", gap: 8 }}>
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
                  />
                  <label
                    title={t("photoUploadHint")}
                    style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}
                  >
                    <span className="btn btn-sm">📷 {t("chooseFile")}</span>
                    <span style={{ color: "var(--muted)", fontSize: 13 }}>{workoutFile?.name}</span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => setWorkoutFile(e.target.files?.[0] ?? null)}
                      style={{ display: "none" }}
                    />
                  </label>
                  <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>{t("photoUploadHint")}</p>
                  <button type="submit" className="btn-primary" disabled={workoutBusy || (!workoutText && !workoutFile)}>
                    {workoutBusy ? t("logging") : t("logIt")}
                  </button>
                </form>
              </div>
            </details>
          </section>

          <section style={{ marginTop: 28 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
              <h2 style={{ margin: 0 }}>{t("steps")}</h2>
              <span style={{ fontSize: 13, color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
                <bdi dir="ltr">
                  {steps?.steps ?? 0} / {goals.stepGoal ?? 10000}
                </bdi>{" "}
                {t("goal")}
              </span>
            </div>

            <details className="disclosure" style={{ marginTop: 12 }}>
              <summary>{t("updateSteps")}</summary>
              <div className="disclosure__body">
                <form onSubmit={submitSteps} style={{ display: "grid", gap: 8 }}>
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
                  />
                  <label
                    title={t("photoUploadHint")}
                    style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}
                  >
                    <span className="btn btn-sm">📷 {t("chooseFile")}</span>
                    <span style={{ color: "var(--muted)", fontSize: 13 }}>{stepsFile?.name}</span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => setStepsFile(e.target.files?.[0] ?? null)}
                      style={{ display: "none" }}
                    />
                  </label>
                  <button type="submit" className="btn-primary" disabled={stepsBusy || (!stepsText && !stepsFile)}>
                    {stepsBusy ? t("logging") : t("logSteps")}
                  </button>
                </form>
              </div>
            </details>
          </section>
        </>
      )}
    </main>
  );
}

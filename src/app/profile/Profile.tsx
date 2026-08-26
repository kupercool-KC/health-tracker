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
import { useAuth } from "@/lib/firebase/useAuth";
import { useI18n } from "@/lib/i18n/useI18n";
import { isAdmin } from "@/lib/admin";
import { getFullProfile, getUserGoals } from "@/lib/profile/queries";
import {
  deleteGoalHistoryEntry,
  getGoalHistory,
  recordGoalChange,
  upsertGoalHistoryEntry,
  type GoalHistoryEntry,
} from "@/lib/goals/goalHistory";
import { getMealDaysSince, getWorkoutsSince, localDateKey, localDateKeyDaysAgo } from "@/lib/dashboard/queries";
import { computeNetCalories } from "@/lib/goals/netCalories";
import type { StringKey } from "@/lib/i18n/strings";
import type { ActivityLevel, DietaryPref, Goal, UserProfile, WorkoutType } from "@/lib/types";

const GENDER_OPTIONS: Array<{ value: NonNullable<UserProfile["gender"]>; labelKey: StringKey }> = [
  { value: "male", labelKey: "genderMale" },
  { value: "female", labelKey: "genderFemale" },
  { value: "other", labelKey: "genderOther" },
];
const GOAL_OPTIONS: Array<{ value: Goal; labelKey: StringKey }> = [
  { value: "buildMuscle", labelKey: "goalBuildMuscle" },
  { value: "cut", labelKey: "goalCut" },
  { value: "loseWeight", labelKey: "goalLoseWeight" },
  { value: "maintain", labelKey: "goalMaintain" },
];
const ACTIVITY_OPTIONS: Array<{ value: ActivityLevel; labelKey: StringKey }> = [
  { value: "sedentary", labelKey: "activitySedentary" },
  { value: "light", labelKey: "activityLight" },
  { value: "moderate", labelKey: "activityModerate" },
  { value: "intense", labelKey: "activityIntense" },
  { value: "veryIntense", labelKey: "activityVeryIntense" },
];
const WORKOUT_OPTIONS: Array<{ value: WorkoutType; labelKey: StringKey }> = [
  { value: "strength", labelKey: "workoutStrength" },
  { value: "running", labelKey: "workoutRunning" },
  { value: "walking", labelKey: "workoutWalking" },
  { value: "cycling", labelKey: "workoutCycling" },
  { value: "swimming", labelKey: "workoutSwimming" },
  { value: "yoga", labelKey: "workoutYoga" },
  { value: "padel", labelKey: "workoutPadel" },
  { value: "hiit", labelKey: "workoutHiit" },
  { value: "other", labelKey: "workoutOther" },
];
const DIET_OPTIONS: Array<{ value: DietaryPref; labelKey: StringKey }> = [
  { value: "everything", labelKey: "dietEverything" },
  { value: "vegetarian", labelKey: "dietVegetarian" },
  { value: "vegan", labelKey: "dietVegan" },
  { value: "glutenFree", labelKey: "dietGlutenFree" },
  { value: "lactoseFree", labelKey: "dietLactoseFree" },
  { value: "other", labelKey: "dietOther" },
];

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: "6px 10px",
    borderRadius: 999,
    border: active ? "1.5px solid var(--protein)" : "0.5px solid var(--border)",
    background: active ? "var(--protein-bg)" : "var(--panel)",
    color: active ? "var(--protein)" : "var(--text)",
    fontSize: 13,
  };
}

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

  const [fullProfile, setFullProfile] = useState<UserProfile | null>(null);

  // Editable "Your info" fields — same shape as Onboarding's own state, but
  // seeded from whatever's already saved (see the effect below) rather than
  // hardcoded defaults, since this is for editing an existing profile, not
  // starting one from scratch.
  const [infoAge, setInfoAge] = useState("");
  const [infoGender, setInfoGender] = useState<UserProfile["gender"]>(undefined);
  const [infoHeight, setInfoHeight] = useState("");
  const [infoWeight, setInfoWeight] = useState("");
  const [infoGoals, setInfoGoals] = useState<Goal[]>([]);
  const [infoActivityLevel, setInfoActivityLevel] = useState<ActivityLevel | undefined>(undefined);
  const [infoWorkoutTypes, setInfoWorkoutTypes] = useState<WorkoutType[]>([]);
  const [infoDietaryPrefs, setInfoDietaryPrefs] = useState<DietaryPref[]>([]);
  const [infoAverageDailySteps, setInfoAverageDailySteps] = useState("");
  // Comma-separated free text — simplest input for an unbounded list, no
  // dedicated tag-input component needed for what's a rarely-edited field.
  const [infoAllergies, setInfoAllergies] = useState("");
  const [infoAvoidFoods, setInfoAvoidFoods] = useState("");
  const [infoPreferredFoods, setInfoPreferredFoods] = useState("");
  const [infoBusy, setInfoBusy] = useState(false);
  const [infoSaved, setInfoSaved] = useState(false);

  const [goalHistoryEntries, setGoalHistoryEntries] = useState<GoalHistoryEntry[]>([]);
  const [ghDate, setGhDate] = useState(localDateKey());
  const [ghCalorieGoal, setGhCalorieGoal] = useState("");
  const [ghProteinGoal, setGhProteinGoal] = useState("");
  const [ghBusy, setGhBusy] = useState(false);

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
    getGoalHistory(user.uid).then((entries) => {
      setGoalHistoryEntries([...entries].sort((a, b) => b.date.localeCompare(a.date)));
    });
    getFullProfile(user.uid).then((p) => {
      setFullProfile(p ?? null);
      if (!p) return;
      if (p.age != null) setInfoAge(String(p.age));
      if (p.gender) setInfoGender(p.gender);
      if (p.height != null) setInfoHeight(String(p.height));
      if (p.weight != null) setInfoWeight(String(p.weight));
      if (p.goals) setInfoGoals(p.goals);
      if (p.activityLevel) setInfoActivityLevel(p.activityLevel);
      if (p.workoutTypes) setInfoWorkoutTypes(p.workoutTypes);
      if (p.dietaryPrefs) setInfoDietaryPrefs(p.dietaryPrefs);
      if (p.averageDailySteps != null) setInfoAverageDailySteps(String(p.averageDailySteps));
      if (p.allergies) setInfoAllergies(p.allergies.join(", "));
      if (p.avoidFoods) setInfoAvoidFoods(p.avoidFoods.join(", "));
      if (p.preferredFoods) setInfoPreferredFoods(p.preferredFoods.join(", "));
    });
  }, [user]);

  async function addGoalHistoryEntry() {
    if (!user || !ghDate) return;
    setGhBusy(true);
    setError(null);
    try {
      const entry: GoalHistoryEntry = {
        date: ghDate,
        ...(ghCalorieGoal ? { calorieGoal: Number(ghCalorieGoal) } : {}),
        ...(ghProteinGoal ? { proteinGoal: Number(ghProteinGoal) } : {}),
      };
      await upsertGoalHistoryEntry(user.uid, entry);
      const entries = await getGoalHistory(user.uid);
      setGoalHistoryEntries([...entries].sort((a, b) => b.date.localeCompare(a.date)));
      setGhCalorieGoal("");
      setGhProteinGoal("");
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setGhBusy(false);
    }
  }

  async function removeGoalHistoryEntry(date: string) {
    if (!user) return;
    setGhBusy(true);
    setError(null);
    try {
      await deleteGoalHistoryEntry(user.uid, date);
      const entries = await getGoalHistory(user.uid);
      setGoalHistoryEntries([...entries].sort((a, b) => b.date.localeCompare(a.date)));
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setGhBusy(false);
    }
  }

  function toggleInfoGoal(value: Goal) {
    setInfoGoals((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  }
  function toggleInfoWorkoutType(value: WorkoutType) {
    setInfoWorkoutTypes((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  }
  function toggleInfoDietaryPref(value: DietaryPref) {
    setInfoDietaryPrefs((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  }

  /** Comma-separated free text → a trimmed, non-empty string array (or undefined for an empty field, so it clears rather than writing `[]` forever). */
  function parseCommaList(text: string): string[] | undefined {
    const items = text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }

  async function saveInfo() {
    if (!user) return;
    setInfoBusy(true);
    setInfoSaved(false);
    setError(null);
    try {
      const ref = doc(db, "users", user.uid, "meta", "profile");
      const update: Partial<UserProfile> = {
        ...(infoAge ? { age: Number(infoAge) } : {}),
        ...(infoGender ? { gender: infoGender } : {}),
        ...(infoHeight ? { height: Number(infoHeight) } : {}),
        ...(infoWeight ? { weight: Number(infoWeight) } : {}),
        goals: infoGoals,
        ...(infoActivityLevel ? { activityLevel: infoActivityLevel } : {}),
        workoutTypes: infoWorkoutTypes,
        dietaryPrefs: infoDietaryPrefs,
        ...(infoAverageDailySteps ? { averageDailySteps: Number(infoAverageDailySteps) } : {}),
        allergies: parseCommaList(infoAllergies) ?? [],
        avoidFoods: parseCommaList(infoAvoidFoods) ?? [],
        preferredFoods: parseCommaList(infoPreferredFoods) ?? [],
        updatedAt: new Date().toISOString(),
      };
      await setDoc(ref, update, { merge: true });
      setFullProfile((prev) => ({ ...(prev ?? ({} as UserProfile)), ...update }));
      setInfoSaved(true);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setInfoBusy(false);
    }
  }

  async function saveGoals() {
    if (!user) return;
    setGoalsBusy(true);
    setGoalsSaved(false);
    try {
      const before = await getUserGoals(user.uid);
      const ref = doc(db, "users", user.uid, "meta", "profile");
      const after = {
        calorieGoal: Number(calorieGoal) || 0,
        proteinGoal: Number(proteinGoal) || 0,
        stepGoal: Number(stepGoal) || 0,
        netCalorieBurnFactor: Math.min(100, Math.max(0, Number(netFactor) || 0)),
      };
      await setDoc(
        ref,
        {
          ...after,
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      );
      await recordGoalChange(user.uid, before, after);
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
        {authError && <p style={{ color: "#ff6b6b", fontSize: 13 }}>{t("signInFailed")}: {authError}</p>}
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

      <div className="card" style={{ marginTop: 16, display: "grid", gap: 10 }}>
        <h2 style={{ margin: 0 }}>{t("yourInfoTitle")}</h2>

        <div style={{ display: "flex", gap: 8 }}>
          <label style={{ display: "grid", gap: 4, flex: 1 }}>
            <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("ageLabel")}</span>
            <input
              type="number"
              value={infoAge}
              onChange={(e) => setInfoAge(e.target.value)}
              style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
            />
          </label>
          <label style={{ display: "grid", gap: 4, flex: 1 }}>
            <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("heightLabel")}</span>
            <input
              type="number"
              value={infoHeight}
              onChange={(e) => setInfoHeight(e.target.value)}
              style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
            />
          </label>
          <label style={{ display: "grid", gap: 4, flex: 1 }}>
            <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("weightLabel")}</span>
            <input
              type="number"
              value={infoWeight}
              onChange={(e) => setInfoWeight(e.target.value)}
              style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
            />
          </label>
        </div>

        <div style={{ display: "grid", gap: 4 }}>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("genderLabel")}</span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {GENDER_OPTIONS.map((o) => (
              <button key={o.value} type="button" onClick={() => setInfoGender(o.value)} style={chipStyle(infoGender === o.value)}>
                {t(o.labelKey)}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gap: 4 }}>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("onboardingStep3Title")}</span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {ACTIVITY_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => setInfoActivityLevel(o.value)}
                style={chipStyle(infoActivityLevel === o.value)}
              >
                {t(o.labelKey)}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gap: 4 }}>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>
            {t("onboardingStep2Title")} <span style={{ opacity: 0.7 }}>({t("multiSelectHint")})</span>
          </span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {GOAL_OPTIONS.map((o) => (
              <button key={o.value} type="button" onClick={() => toggleInfoGoal(o.value)} style={chipStyle(infoGoals.includes(o.value))}>
                {t(o.labelKey)}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gap: 4 }}>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>
            {t("onboardingStep4Title")} <span style={{ opacity: 0.7 }}>({t("multiSelectHint")})</span>
          </span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {WORKOUT_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => toggleInfoWorkoutType(o.value)}
                style={chipStyle(infoWorkoutTypes.includes(o.value))}
              >
                {t(o.labelKey)}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gap: 4 }}>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>
            {t("onboardingStep5Title")} <span style={{ opacity: 0.7 }}>({t("multiSelectHint")})</span>
          </span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {DIET_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => toggleInfoDietaryPref(o.value)}
                style={chipStyle(infoDietaryPrefs.includes(o.value))}
              >
                {t(o.labelKey)}
              </button>
            ))}
          </div>
        </div>

        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("averageDailyStepsLabel")}</span>
          <input
            type="number"
            value={infoAverageDailySteps}
            onChange={(e) => setInfoAverageDailySteps(e.target.value)}
            style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)", maxWidth: 160 }}
          />
        </label>

        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("allergiesLabel")}</span>
          <input
            value={infoAllergies}
            onChange={(e) => setInfoAllergies(e.target.value)}
            placeholder={t("commaSeparatedHint")}
            style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
          />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("avoidFoodsLabel")}</span>
          <input
            value={infoAvoidFoods}
            onChange={(e) => setInfoAvoidFoods(e.target.value)}
            placeholder={t("commaSeparatedHint")}
            style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
          />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("preferredFoodsLabel")}</span>
          <input
            value={infoPreferredFoods}
            onChange={(e) => setInfoPreferredFoods(e.target.value)}
            placeholder={t("commaSeparatedHint")}
            style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
          />
        </label>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={saveInfo} disabled={infoBusy}>
            {infoBusy ? t("working") : t("save")}
          </button>
          <Link href="/onboarding" style={{ color: "var(--protein)", fontSize: 13 }}>
            {t("recalculateGoals")}
          </Link>
        </div>
        {infoSaved && <p style={{ color: "var(--burned)", margin: 0 }}>{t("saved")}</p>}
        {!fullProfile && <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>{t("yourInfoNone")}</p>}
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

      <div className="card" style={{ marginTop: 16, display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0 }}>{t("goalHistoryTitle")}</h2>
        <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>{t("goalHistoryExplainer")}</p>

        {goalHistoryEntries.length === 0 ? (
          <p style={{ color: "var(--muted)", fontSize: 13 }}>{t("goalHistoryNoEntries")}</p>
        ) : (
          <div style={{ display: "grid", gap: 4 }}>
            {goalHistoryEntries.map((entry) => (
              <div
                key={entry.date}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, borderTop: "0.5px solid var(--border)", padding: "6px 0" }}
              >
                <bdi dir="ltr">{entry.date}</bdi>
                <bdi dir="ltr" style={{ color: "var(--muted)" }}>
                  {entry.calorieGoal != null && `${entry.calorieGoal} kcal`}
                  {entry.calorieGoal != null && entry.proteinGoal != null && " · "}
                  {entry.proteinGoal != null && `${entry.proteinGoal}${t("unitG")} ${t("protein")}`}
                </bdi>
                <button
                  onClick={() => removeGoalHistoryEntry(entry.date)}
                  disabled={ghBusy}
                  aria-label={t("delete")}
                  title={t("delete")}
                  style={{ border: "none", background: "none", padding: 2, fontSize: 13, color: "var(--calories)" }}
                >
                  🗑️
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "grid", gap: 8, borderTop: "0.5px solid var(--border)", paddingTop: 8 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("goalHistoryDateLabel")}</span>
            <input
              type="date"
              value={ghDate}
              max={localDateKey()}
              onChange={(e) => setGhDate(e.target.value)}
              style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
            />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="number"
              value={ghCalorieGoal}
              onChange={(e) => setGhCalorieGoal(e.target.value)}
              placeholder={t("calorieGoalLabel")}
              style={{ flex: 1, padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
            />
            <input
              type="number"
              value={ghProteinGoal}
              onChange={(e) => setGhProteinGoal(e.target.value)}
              placeholder={t("proteinGoalLabel")}
              style={{ flex: 1, padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
            />
          </div>
          <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>{t("goalHistoryLeaveBlankHint")}</p>
          <button onClick={addGoalHistoryEntry} disabled={ghBusy || (!ghCalorieGoal && !ghProteinGoal)}>
            {ghBusy ? t("working") : t("goalHistoryAddEntry")}
          </button>
        </div>
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

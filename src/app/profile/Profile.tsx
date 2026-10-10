"use client";

/**
 * Profile screen. Full 4-section spec (dietary profile, alerts, memory,
 * goals & display) is a later phase — this ships the Apple Health sync
 * token management (previously at /settings) plus a quick goal-editing
 * shortcut, so the nav's profile icon has real content rather than a
 * placeholder. The full onboarding wizard (BMR/TDEE calculation) is still a
 * separate follow-up — this is a stopgap that lets you just type numbers in.
 */
import AppleSignInButton from "@/app/AppleSignInButton";
import { useEffect, useState } from "react";
import Link from "next/link";
import { doc, setDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/useAuth";
import NutrientTargetsCard from "@/app/profile/NutrientTargetsCard";
import {
  connectAppleHealth,
  isAppleHealthEnabled,
  isAppleHealthSupported,
  setAppleHealthEnabled,
  syncAppleHealth,
} from "@/lib/health/appleHealth";
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
import type { ActivityLevel, CustomGoalDef, DietaryPref, Goal, ReminderConfig, UserProfile, WorkoutType } from "@/lib/types";

type ReminderSettingsState = {
  breakfastCheckIn: ReminderConfig;
  middayCheckIn: ReminderConfig & { thresholdPercent: number };
  eveningSummary: ReminderConfig;
  morningRecap: ReminderConfig;
  weeklyWeighIn: ReminderConfig;
  customGoalsCheckIn: ReminderConfig;
};

const REMINDER_DEFAULTS: ReminderSettingsState = {
  breakfastCheckIn: { enabled: false, time: "10:00" },
  middayCheckIn: { enabled: false, time: "15:00", thresholdPercent: 40 },
  eveningSummary: { enabled: false, time: "21:00" },
  morningRecap: { enabled: false, time: "08:00" },
  weeklyWeighIn: { enabled: false, time: "09:00" },
  customGoalsCheckIn: { enabled: false, time: "20:30" },
};

const REMINDER_ROWS: Array<{ key: keyof ReminderSettingsState; labelKey: StringKey }> = [
  { key: "breakfastCheckIn", labelKey: "reminderBreakfastCheckIn" },
  { key: "middayCheckIn", labelKey: "reminderMiddayCheckIn" },
  { key: "eveningSummary", labelKey: "reminderEveningSummary" },
  { key: "morningRecap", labelKey: "reminderMorningRecap" },
  { key: "weeklyWeighIn", labelKey: "reminderWeeklyWeighIn" },
  { key: "customGoalsCheckIn", labelKey: "reminderCustomGoalsCheckIn" },
];

/** Offered as one-tap starting points when the user has no custom goals yet — still fully editable/removable afterward. `nameKey`/`unitKey` resolve through t() at add-time so the stored name matches whatever language the user is in. */
const SUGGESTED_GOALS: Array<{ nameKey: StringKey; type: "boolean" | "numeric"; unitKey?: StringKey; target?: number }> = [
  { nameKey: "suggestedGoalWater", type: "numeric", unitKey: "suggestedGoalCupsUnit", target: 8 },
  { nameKey: "suggestedGoalRead", type: "numeric", unitKey: "suggestedGoalPagesUnit", target: 10 },
  { nameKey: "suggestedGoalSleep", type: "boolean" },
  { nameKey: "suggestedGoalMeditate", type: "boolean" },
  { nameKey: "suggestedGoalStretch", type: "boolean" },
];

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

  const [customGoals, setCustomGoals] = useState<CustomGoalDef[]>([]);
  const [newGoalName, setNewGoalName] = useState("");
  const [newGoalType, setNewGoalType] = useState<"boolean" | "numeric">("boolean");
  const [newGoalUnit, setNewGoalUnit] = useState("");
  const [newGoalTarget, setNewGoalTarget] = useState("");
  const [customGoalsBusy, setCustomGoalsBusy] = useState(false);

  const [linkCode, setLinkCode] = useState<{ code: string; botNumber: string | null } | null>(null);
  const [healthOn, setHealthOn] = useState(false);
  const [healthBusy, setHealthBusy] = useState(false);
  const [healthMsg, setHealthMsg] = useState<string | null>(null);
  useEffect(() => setHealthOn(isAppleHealthEnabled()), []);
  async function connectHealth() {
    setHealthBusy(true);
    setHealthMsg(null);
    try {
      if (!(await connectAppleHealth())) {
        setHealthMsg(t("appleHealthUnavailable"));
        return;
      }
      setHealthOn(true);
      await syncAppleHealth();
      setHealthMsg(t("appleHealthSynced"));
    } catch (err) {
      setHealthMsg(String(err instanceof Error ? err.message : err));
    } finally {
      setHealthBusy(false);
    }
  }
  async function syncHealthNow() {
    setHealthBusy(true);
    setHealthMsg(null);
    try {
      await syncAppleHealth();
      setHealthMsg(t("appleHealthSynced"));
    } catch (err) {
      setHealthMsg(String(err instanceof Error ? err.message : err));
    } finally {
      setHealthBusy(false);
    }
  }
  function disconnectHealth() {
    setAppleHealthEnabled(false);
    setHealthOn(false);
    setHealthMsg(t("appleHealthDisconnectNote"));
  }
  const [whatsappBusy, setWhatsappBusy] = useState(false);
  const [whatsappError, setWhatsappError] = useState<string | null>(null);

  const [reminders, setReminders] = useState<ReminderSettingsState>(REMINDER_DEFAULTS);
  const [remindersBusy, setRemindersBusy] = useState(false);
  const [remindersSaved, setRemindersSaved] = useState(false);

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
      if (p.customGoals) setCustomGoals(p.customGoals);
      if (p.whatsappPhone) {
        auth.currentUser
          ?.getIdToken()
          .then((idToken) => fetch("/api/whatsapp/reminders", { headers: { Authorization: `Bearer ${idToken}` } }))
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => data && setReminders(data))
          .catch(() => {});
      }
    });
  }, [user]);

  async function saveCustomGoals(next: CustomGoalDef[]) {
    if (!user) return;
    setCustomGoalsBusy(true);
    setError(null);
    try {
      const ref = doc(db, "users", user.uid, "meta", "profile");
      await setDoc(ref, { customGoals: next, updatedAt: new Date().toISOString() }, { merge: true });
      setCustomGoals(next);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setCustomGoalsBusy(false);
    }
  }

  function addCustomGoal(def: Omit<CustomGoalDef, "id">) {
    saveCustomGoals([...customGoals, { ...def, id: crypto.randomUUID() }]);
  }

  function removeCustomGoal(id: string) {
    saveCustomGoals(customGoals.filter((g) => g.id !== id));
  }

  function submitNewGoal() {
    if (!newGoalName.trim()) return;
    addCustomGoal({
      name: newGoalName.trim(),
      type: newGoalType,
      ...(newGoalType === "numeric" ? { unit: newGoalUnit.trim() || undefined, target: Number(newGoalTarget) || undefined } : {}),
    });
    setNewGoalName("");
    setNewGoalUnit("");
    setNewGoalTarget("");
  }

  async function linkWhatsapp() {
    if (!user) return;
    setWhatsappBusy(true);
    setWhatsappError(null);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) throw new Error("Not signed in");
      const res = await fetch("/api/whatsapp/link", { method: "POST", headers: { Authorization: `Bearer ${idToken}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setLinkCode({ code: data.code, botNumber: data.botNumber ?? null });
    } catch (err) {
      setWhatsappError(String(err instanceof Error ? err.message : err));
    } finally {
      setWhatsappBusy(false);
    }
  }

  // While a code is showing, watch for the link to land (the user sends it from WhatsApp, the server links the number).
  useEffect(() => {
    if (!user || !linkCode) return;
    const timer = setInterval(() => {
      getFullProfile(user.uid).then((p) => {
        if (p?.whatsappPhone) {
          setFullProfile(p);
          setLinkCode(null);
        }
      });
    }, 4000);
    return () => clearInterval(timer);
  }, [user, linkCode]);

  const [deleteBusy, setDeleteBusy] = useState(false);
  async function deleteMyAccount() {
    if (!user || !window.confirm(t("deleteAccountConfirm"))) return;
    setDeleteBusy(true);
    setError(null);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) throw new Error("Not signed in");
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
      await signOutUser();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      setDeleteBusy(false);
    }
  }

  async function unlinkWhatsapp() {
    if (!user || !fullProfile?.whatsappPhone) return;
    setWhatsappBusy(true);
    setWhatsappError(null);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) throw new Error("Not signed in");
      const res = await fetch("/api/whatsapp/link", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ phone: fullProfile.whatsappPhone }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
      setFullProfile((prev) => (prev ? { ...prev, whatsappPhone: undefined } : prev));
    } catch (err) {
      setWhatsappError(String(err instanceof Error ? err.message : err));
    } finally {
      setWhatsappBusy(false);
    }
  }

  function updateReminder(key: keyof ReminderSettingsState, patch: Partial<ReminderSettingsState[typeof key]>) {
    setReminders((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  async function saveReminders() {
    if (!user) return;
    setRemindersBusy(true);
    setRemindersSaved(false);
    setError(null);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) throw new Error("Not signed in");
      const res = await fetch("/api/whatsapp/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify(reminders),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
      setRemindersSaved(true);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setRemindersBusy(false);
    }
  }

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
        <AppleSignInButton />
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

      <NutrientTargetsCard />

      {isAppleHealthSupported() && (
        <div className="card" style={{ marginTop: 16, display: "grid", gap: 8 }}>
          <h2 style={{ margin: 0 }}>{t("appleHealthTitle")}</h2>
          <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>{t("appleHealthHint")}</p>
          {healthOn ? (
            <>
              <span style={{ fontSize: 13 }}>{t("appleHealthConnected")}</span>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={syncHealthNow} disabled={healthBusy}>
                  {healthBusy ? t("working") : t("appleHealthSyncNow")}
                </button>
                <button onClick={disconnectHealth} disabled={healthBusy}>
                  {t("appleHealthDisconnect")}
                </button>
              </div>
            </>
          ) : (
            <div>
              <button onClick={connectHealth} disabled={healthBusy}>
                {healthBusy ? t("working") : t("appleHealthConnect")}
              </button>
            </div>
          )}
          {healthMsg && <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>{healthMsg}</p>}
        </div>
      )}

      <div className="card" style={{ marginTop: 16, display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0 }}>{t("whatsappLinkTitle")}</h2>
        <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>{t("whatsappLinkHint")}</p>

        {fullProfile?.whatsappPhone ? (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 13 }}>
              {t("whatsappLinkedAs")} <bdi dir="ltr">+{fullProfile.whatsappPhone}</bdi>
            </span>
            <button onClick={unlinkWhatsapp} disabled={whatsappBusy}>
              {whatsappBusy ? t("working") : t("whatsappUnlinkButton")}
            </button>
          </div>
        ) : (
          linkCode ? (
            <div style={{ display: "grid", gap: 8 }}>
              <span style={{ fontSize: 13 }}>{t("whatsappCodeInstructions")}</span>
              <bdi dir="ltr" style={{ fontSize: 28, fontWeight: 600, letterSpacing: 4 }}>
                {linkCode.code}
              </bdi>
              {linkCode.botNumber && (
                <a href={`https://wa.me/${linkCode.botNumber}?text=${linkCode.code}`} target="_blank" rel="noreferrer">
                  {t("whatsappOpenChatButton")}
                </a>
              )}
              <span style={{ color: "var(--muted)", fontSize: 12 }}>{t("whatsappWaitingForCode")}</span>
            </div>
          ) : (
            <div>
              <button onClick={linkWhatsapp} disabled={whatsappBusy}>
                {whatsappBusy ? t("working") : t("whatsappGetCodeButton")}
              </button>
            </div>
          )
        )}
        {whatsappError && <p style={{ color: "#ff6b6b", fontSize: 12, margin: 0 }}>{whatsappError}</p>}
      </div>

      <div className="card" style={{ marginTop: 16, display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0 }}>{t("whatsappRemindersTitle")}</h2>
        <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>{t("whatsappRemindersHint")}</p>

        {!fullProfile?.whatsappPhone ? (
          <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>{t("whatsappRemindersNeedsLink")}</p>
        ) : (
          <>
            <div style={{ display: "grid", gap: 8 }}>
              {REMINDER_ROWS.map((row) => {
                const config = reminders[row.key];
                return (
                  <div
                    key={row.key}
                    style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, borderTop: "0.5px solid var(--border)", paddingTop: 8 }}
                  >
                    <label style={{ display: "flex", alignItems: "center", gap: 6, flex: "1 1 220px", fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={config.enabled}
                        onChange={(e) => updateReminder(row.key, { enabled: e.target.checked })}
                      />
                      {t(row.labelKey)}
                    </label>
                    <input
                      type="time"
                      value={config.time}
                      onChange={(e) => updateReminder(row.key, { time: e.target.value })}
                      style={{ padding: 6, borderRadius: 8, border: "0.5px solid var(--border)" }}
                    />
                    {row.key === "middayCheckIn" && (
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={reminders.middayCheckIn.thresholdPercent}
                        onChange={(e) => updateReminder("middayCheckIn", { thresholdPercent: Number(e.target.value) || 0 })}
                        style={{ width: 64, padding: 6, borderRadius: 8, border: "0.5px solid var(--border)" }}
                        title="%"
                      />
                    )}
                  </div>
                );
              })}
            </div>
            <button onClick={saveReminders} disabled={remindersBusy}>
              {remindersBusy ? t("working") : t("saveReminders")}
            </button>
            {remindersSaved && <p style={{ color: "var(--burned)", margin: 0 }}>{t("saved")}</p>}
          </>
        )}
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
        <h2 style={{ margin: 0 }}>{t("customGoalsTitle")}</h2>
        <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>{t("customGoalsHint")}</p>

        {customGoals.length > 0 && (
          <div style={{ display: "grid", gap: 4 }}>
            {customGoals.map((g) => (
              <div
                key={g.id}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, borderTop: "0.5px solid var(--border)", padding: "6px 0" }}
              >
                <span>
                  {g.name}
                  {g.type === "numeric" && (
                    <span style={{ color: "var(--muted)" }}>
                      {" "}
                      ({g.target ?? "?"} {g.unit ?? ""})
                    </span>
                  )}
                </span>
                <button
                  onClick={() => removeCustomGoal(g.id)}
                  disabled={customGoalsBusy}
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

        {customGoals.length === 0 && (
          <div style={{ display: "grid", gap: 4 }}>
            <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("suggestedGoalsLabel")}</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {SUGGESTED_GOALS.map((g) => (
                <button
                  key={g.nameKey}
                  type="button"
                  onClick={() =>
                    addCustomGoal({
                      name: t(g.nameKey),
                      type: g.type,
                      ...(g.unitKey ? { unit: t(g.unitKey) } : {}),
                      ...(g.target != null ? { target: g.target } : {}),
                    })
                  }
                  disabled={customGoalsBusy}
                  style={chipStyle(false)}
                >
                  {t(g.nameKey)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: "grid", gap: 8, borderTop: "0.5px solid var(--border)", paddingTop: 8 }}>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("addYourOwnGoalLabel")}</span>
          <input
            value={newGoalName}
            onChange={(e) => setNewGoalName(e.target.value)}
            placeholder={t("goalNamePlaceholder")}
            style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={newGoalType === "numeric"}
              onChange={(e) => setNewGoalType(e.target.checked ? "numeric" : "boolean")}
            />
            {t("goalHasNumericTargetLabel")}
          </label>
          {newGoalType === "numeric" && (
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="number"
                value={newGoalTarget}
                onChange={(e) => setNewGoalTarget(e.target.value)}
                placeholder={t("goalTargetPlaceholder")}
                style={{ flex: 1, padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
              />
              <input
                value={newGoalUnit}
                onChange={(e) => setNewGoalUnit(e.target.value)}
                placeholder={t("goalUnitPlaceholder")}
                style={{ flex: 1, padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
              />
            </div>
          )}
          <button onClick={submitNewGoal} disabled={customGoalsBusy || !newGoalName.trim()}>
            {customGoalsBusy ? t("working") : t("addCustomGoal")}
          </button>
        </div>
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

      <div className="card" style={{ marginTop: 16, display: "flex", gap: 16 }}>
        <Link href="/privacy" style={{ color: "var(--muted)" }}>{t("privacyPolicyLink")}</Link>
        <Link href="/terms" style={{ color: "var(--muted)" }}>{t("termsLink")}</Link>
        <Link href="/support" style={{ color: "var(--muted)" }}>{t("supportLink")}</Link>
      </div>

      <div className="card" style={{ marginTop: 16, display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0 }}>{t("deleteAccountTitle")}</h2>
        <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>{t("deleteAccountHint")}</p>
        <div>
          <button onClick={deleteMyAccount} disabled={deleteBusy} style={{ color: "#ff6b6b" }}>
            {deleteBusy ? t("working") : t("deleteAccountButton")}
          </button>
        </div>
      </div>
    </main>
  );
}

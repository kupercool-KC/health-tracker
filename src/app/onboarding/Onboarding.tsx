"use client";

/**
 * Onboarding wizard: one question per screen, progress bar at top, final
 * calculated-profile confirmation screen. Re-runnable from Profile →
 * "Recalculate goals from formula".
 *
 * No "desired change rate" question — the expected weekly rate of change is
 * derived from the calorie deficit/surplus the calculated goal already
 * implies (see calculateGoals) and just displayed on the final screen,
 * rather than asked as a separate input.
 */
import AppleSignInButton from "@/app/AppleSignInButton";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { doc, setDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/useAuth";
import { useI18n } from "@/lib/i18n/useI18n";
import type { StringKey } from "@/lib/i18n/strings";
import { calculateBmr, calculateGoals, calculateTdee } from "@/lib/goals/calculate";
import { getFullProfile, getUserGoals } from "@/lib/profile/queries";
import { recordGoalChange } from "@/lib/goals/goalHistory";
import { DIET_STYLES, computeAutoTargets } from "@/lib/nutrition/nutrients";
import { defaultWaterGoalMl } from "@/lib/water/water";
import { INITIAL_IMPORT_DAYS, connectAppleHealth, importAppleHealth, isAppleHealthEnabled, isAppleHealthSupported } from "@/lib/health/appleHealth";
import type { HealthSuggestions } from "@/lib/health/suggestions";
import type {
  ActivityLevel,
  DietStyle,
  DietaryPref,
  Goal,
  UserProfile,
  WorkoutType,
} from "@/lib/types";

const TOTAL_STEPS = 7;

const AGE_OPTIONS = Array.from({ length: 91 }, (_, i) => i + 10); // 10-100
const HEIGHT_OPTIONS = Array.from({ length: 121 }, (_, i) => i + 100); // 100-220 cm
const WEIGHT_OPTIONS = Array.from({ length: 171 }, (_, i) => i + 30); // 30-200 kg

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

export default function Onboarding() {
  const { user, loading: authLoading, authError, signIn } = useAuth();
  const { t, lang } = useI18n();
  const router = useRouter();

  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [dietStyle, setDietStyle] = useState<DietStyle>("balanced");
  // Daily water goal (ml); stays on the weight-based default until the user edits it.
  const [waterGoal, setWaterGoal] = useState<number | null>(null);
  // Optional goal for the Progress timeline.
  const [targetWeight, setTargetWeight] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [targetHint, setTargetHint] = useState<string | null>(null);
  const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const quickWeeks = (n: number) => setTargetDate(dayKey(Date.now() + n * 7 * 86_400_000));
  /** Safe pace: at most 1% of body weight a week. Returns false (and suggests a later date) when the chosen date is too soon. */
  function targetIsSafe(): boolean {
    const kg = Number(targetWeight);
    if (!targetWeight || !Number.isFinite(kg)) return true;
    const weeks = Math.ceil(Math.abs(kg - weight) / (weight * 0.01));
    const earliest = dayKey(Date.now() + weeks * 7 * 86_400_000);
    if (targetDate && targetDate < earliest && Math.abs(kg - weight) > 0.5) {
      setTargetDate(earliest);
      setTargetHint(t("progressSafePace").replace("{date}", earliest));
      return false;
    }
    setTargetHint(null);
    return true;
  }

  // Apple Health pre-step (native iOS app only): ask → explain → import → summary, then the usual steps open pre-filled.
  type HealthPhase = "done" | "ask" | "explain" | "importing" | "summary" | "nothing";
  const [healthPhase, setHealthPhase] = useState<HealthPhase>("done");
  const [healthSummary, setHealthSummary] = useState<HealthSuggestions | null>(null);
  const [fromHealth, setFromHealth] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (user && isAppleHealthSupported() && !isAppleHealthEnabled()) setHealthPhase("ask");
  }, [user]);

  async function startHealthImport() {
    setHealthPhase("importing");
    try {
      const ok = await connectAppleHealth();
      if (!ok) return setHealthPhase("nothing");
      const { suggestions } = await importAppleHealth(INITIAL_IMPORT_DAYS);
      const c = suggestions.counts;
      if (c.workouts + c.sleepNights + c.stepDays === 0 && !suggestions.weightKg) return setHealthPhase("nothing");
      setHealthSummary(suggestions);
      setHealthPhase("summary");
    } catch {
      setHealthPhase("nothing");
    }
  }

  function applyHealthSuggestions(sg: HealthSuggestions) {
    const used = new Set<string>();
    if (sg.heightCm && sg.heightCm >= 100 && sg.heightCm <= 220) { setHeight(sg.heightCm); used.add("basic"); }
    if (sg.weightKg && sg.weightKg >= 30 && sg.weightKg <= 200) { setWeight(Math.round(sg.weightKg)); used.add("basic"); }
    if (sg.activityLevel) { setActivityLevel(sg.activityLevel); used.add("activity"); }
    if (sg.workoutTypes.length) { setWorkoutTypes(sg.workoutTypes); used.add("workouts"); }
    if (sg.averageDailySteps) { setAverageDailySteps(sg.averageDailySteps); used.add("steps"); }
    if (sg.stepGoal) { setStepGoal(sg.stepGoal); used.add("steps"); }
    setFromHealth(used);
    setHealthPhase("done");
  }

  const [age, setAge] = useState(30);
  const [gender, setGender] = useState<UserProfile["gender"]>("male");
  const [height, setHeight] = useState(175);
  const [weight, setWeight] = useState(75);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [activityLevel, setActivityLevel] = useState<ActivityLevel>("moderate");
  const [workoutTypes, setWorkoutTypes] = useState<WorkoutType[]>([]);
  const [dietaryPrefs, setDietaryPrefs] = useState<DietaryPref[]>(["everything"]);
  const [averageDailySteps, setAverageDailySteps] = useState(6000);
  const [stepGoal, setStepGoal] = useState(10000);

  const [otherWorkoutText, setOtherWorkoutText] = useState("");
  const [matchingWorkout, setMatchingWorkout] = useState(false);
  const [otherWorkoutMessage, setOtherWorkoutMessage] = useState<string | null>(null);
  const [otherDietText, setOtherDietText] = useState("");
  const [matchingDiet, setMatchingDiet] = useState(false);
  const [otherDietMessage, setOtherDietMessage] = useState<string | null>(null);

  // Re-running the wizard ("Recalculate goals from formula" on Profile)
  // previously always started every field back at its hardcoded default
  // (age 30, height 175cm, etc.) instead of the answers already on file —
  // silently overwriting real data with defaults for anything the user
  // didn't happen to re-enter identically. Prefill from whatever's already
  // saved, falling back to the same defaults only for a genuinely first-time
  // run (no profile doc yet).
  useEffect(() => {
    if (!user) return;
    getFullProfile(user.uid).then((p) => {
      if (!p) return;
      if (p.age != null) setAge(p.age);
      if (p.gender) setGender(p.gender);
      if (p.height != null) setHeight(p.height);
      if (p.weight != null) setWeight(p.weight);
      if (p.goals) setGoals(p.goals);
      if (p.activityLevel) setActivityLevel(p.activityLevel);
      if (p.workoutTypes) setWorkoutTypes(p.workoutTypes);
      if (p.dietaryPrefs) setDietaryPrefs(p.dietaryPrefs);
      if (p.averageDailySteps != null) setAverageDailySteps(p.averageDailySteps);
      if (p.stepGoal != null) setStepGoal(p.stepGoal);
      if (p.dietStyle) setDietStyle(p.dietStyle);
      if (p.waterGoalMl != null) setWaterGoal(p.waterGoalMl);
    });
  }, [user]);

  function toggleGoal(value: Goal) {
    setGoals((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  }

  function toggleWorkoutType(value: WorkoutType) {
    setWorkoutTypes((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  }

  function toggleDietaryPref(value: DietaryPref) {
    setDietaryPrefs((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  }

  /**
   * Sends a freeform "other" description to /api/onboarding/classify and
   * merges whatever real categories it matches into the given selection —
   * so "I do pilates and rock climbing" can auto-select existing categories
   * instead of leaving everything bucketed under "other".
   */
  async function matchOther<V extends string>(
    text: string,
    options: Array<{ value: V; labelKey: StringKey }>,
    apply: (matched: V[]) => void,
    setBusy: (b: boolean) => void,
    clearText: () => void,
    setMessage: (m: string | null) => void,
  ) {
    if (!text.trim()) return;
    // Clear immediately, same as the chat panel and Today's add-meal box —
    // the box shouldn't keep showing the text while it's being checked.
    clearText();
    setMessage(null);
    setBusy(true);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) return;
      const categories = options.filter((o) => o.value !== "other").map((o) => ({ value: o.value, label: t(o.labelKey) }));
      const res = await fetch("/api/onboarding/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ text, categories, lang }),
      });
      if (!res.ok) return;
      const data: { matched: string[]; flagged?: boolean; message?: string } = await res.json();
      if (data.flagged) {
        setMessage(data.message ?? null);
        return;
      }
      apply(data.matched.filter((v): v is V => options.some((o) => o.value === v)));
    } finally {
      setBusy(false);
    }
  }

  const bmr = calculateBmr({ gender: gender ?? "other", weightKg: weight, heightCm: height, age });
  const tdee = calculateTdee(bmr, activityLevel);
  const calculated = calculateGoals({ bmr, tdee, goals, weightKg: weight, dietaryPrefs });

  async function confirmAndSave() {
    if (!user) return;
    setBusy(true);
    try {
      const before = await getUserGoals(user.uid);
      const now = new Date().toISOString();
      const ref = doc(db, "users", user.uid, "meta", "profile");
      const update: Partial<UserProfile> = {
        age,
        gender,
        height,
        weight,
        goals,
        activityLevel,
        workoutTypes,
        dietaryPrefs,
        calorieGoal: calculated.calorieGoal,
        proteinGoal: calculated.proteinGoal,
        carbGoal: calculated.carbGoal,
        fatGoal: calculated.fatGoal,
        averageDailySteps,
        stepGoal,
        waterGoalMl: waterGoal ?? defaultWaterGoalMl(weight),
        dietStyle,
        nutrientTargets: computeAutoTargets(calculated.calorieGoal, calculated.proteinGoal, dietStyle),
        ...(targetWeight && Number(targetWeight) >= 30 ? { targetWeightKg: Number(targetWeight), targetDate: targetDate || undefined, startWeightKg: weight, targetSetAt: now } : {}),
        onboarded: true,
        updatedAt: now,
      };
      await setDoc(ref, update, { merge: true });
      await recordGoalChange(user.uid, before, {
        calorieGoal: calculated.calorieGoal,
        proteinGoal: calculated.proteinGoal,
      });
      router.push("/today");
    } finally {
      setBusy(false);
    }
  }

  function OptionButton({
    selected,
    onClick,
    children,
  }: {
    selected: boolean;
    onClick: () => void;
    children: React.ReactNode;
  }) {
    return (
      <button
        type="button"
        onClick={onClick}
        style={{
          textAlign: "start",
          padding: "12px 16px",
          borderRadius: 8,
          border: selected ? "1.5px solid var(--protein)" : "0.5px solid var(--border)",
          background: selected ? "var(--protein-bg)" : "var(--panel)",
          color: "var(--text)",
        }}
      >
        {children}
      </button>
    );
  }

  function NumberSelect({
    value,
    onChange,
    options,
  }: {
    value: number;
    onChange: (v: number) => void;
    options: number[];
  }) {
    return (
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
      >
        {options.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    );
  }

  const progressPct = Math.round((step / TOTAL_STEPS) * 100);

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
        <p style={{ color: "var(--muted)" }}>{t("signInPrompt")}</p>
        <button onClick={() => signIn()}>{t("signInWithGoogle")}</button>
        <AppleSignInButton />
        {authError && <p style={{ color: "#ff6b6b", fontSize: 13 }}>{t("signInFailed")}: {authError}</p>}
      </main>
    );
  }

  if (healthPhase !== "done") {
    const fill = (tpl: string, c: HealthSuggestions["counts"]) => tpl.replace("{w}", String(c.workouts)).replace("{s}", String(c.sleepNights)).replace("{d}", String(c.stepDays));
    return (
      <main>
        {healthPhase === "ask" && (
          <section style={{ display: "grid", gap: 12 }}>
            <h1>{t("healthAskTitle")}</h1>
            <p style={{ color: "var(--muted)" }}>{t("healthAskHint")}</p>
            <OptionButton selected={false} onClick={() => setHealthPhase("explain")}>{t("healthAskYes")}</OptionButton>
            <OptionButton selected={false} onClick={() => setHealthPhase("done")}>{t("healthAskNo")}</OptionButton>
          </section>
        )}
        {healthPhase === "explain" && (
          <section style={{ display: "grid", gap: 12 }}>
            <h1>{t("healthExplainTitle")}</h1>
            <ul style={{ display: "grid", gap: 8, paddingInlineStart: 20, margin: 0 }}>
              <li>{t("healthExplain1")}</li>
              <li>{t("healthExplain2")}</li>
              <li>{t("healthExplain3")}</li>
              <li>{t("healthExplain4")}</li>
            </ul>
            <button onClick={startHealthImport}>{t("healthExplainContinue")}</button>
            <button onClick={() => setHealthPhase("done")} style={{ background: "none", color: "var(--muted)" }}>{t("healthContinueManual")}</button>
          </section>
        )}
        {healthPhase === "importing" && (
          <section style={{ display: "grid", gap: 12 }}>
            <h1>{t("healthImporting")}</h1>
          </section>
        )}
        {healthPhase === "summary" && healthSummary && (
          <section style={{ display: "grid", gap: 12 }}>
            <h1>{t("healthSummaryTitle")}</h1>
            <div className="card">
              <bdi dir="ltr">{fill(t("healthSummaryLine"), healthSummary.counts)}</bdi>
            </div>
            <button onClick={() => applyHealthSuggestions(healthSummary)}>{t("healthSummaryUse")}</button>
            <button onClick={() => setHealthPhase("done")} style={{ background: "none", color: "var(--muted)" }}>{t("healthContinueManual")}</button>
          </section>
        )}
        {healthPhase === "nothing" && (
          <section style={{ display: "grid", gap: 12 }}>
            <p>{t("healthNothing")}</p>
            <button onClick={() => setHealthPhase("done")}>{t("healthContinueManual")}</button>
          </section>
        )}
      </main>
    );
  }

  return (
    <main>
      <div className="progress-track" style={{ marginBottom: 24 }}>
        <div className="progress-fill" style={{ width: `${progressPct}%`, background: "var(--protein)" }} />
      </div>

      {step === 1 && (
        <section style={{ display: "grid", gap: 12 }}>
          <h1>{t("onboardingStep1Title")}</h1>
          {fromHealth.has("basic") && <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>{t("healthFromTag")}</p>}
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("ageLabel")}</span>
            <NumberSelect value={age} onChange={setAge} options={AGE_OPTIONS} />
          </label>
          <div style={{ display: "grid", gap: 4 }}>
            <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("genderLabel")}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <OptionButton selected={gender === "male"} onClick={() => setGender("male")}>{t("genderMale")}</OptionButton>
              <OptionButton selected={gender === "female"} onClick={() => setGender("female")}>{t("genderFemale")}</OptionButton>
              <OptionButton selected={gender === "other"} onClick={() => setGender("other")}>{t("genderOther")}</OptionButton>
            </div>
          </div>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("heightLabel")}</span>
            <NumberSelect value={height} onChange={setHeight} options={HEIGHT_OPTIONS} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("weightLabel")}</span>
            <NumberSelect value={weight} onChange={setWeight} options={WEIGHT_OPTIONS} />
          </label>
        </section>
      )}

      {step === 2 && (
        <section style={{ display: "grid", gap: 8 }}>
          <h1>{t("onboardingStep2Title")}</h1>
          {GOAL_OPTIONS.map((opt) => (
            <OptionButton key={opt.value} selected={goals.includes(opt.value)} onClick={() => toggleGoal(opt.value)}>
              {t(opt.labelKey)}
            </OptionButton>
          ))}
          <h2 style={{ margin: "12px 0 0" }}>{t("progressSetTarget")}</h2>
          <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>{t("progressNoTargetHint")}</p>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("progressTargetWeight")}</span>
            <input id="onb-target-kg" type="number" inputMode="decimal" min={30} max={250} value={targetWeight} onChange={(e) => setTargetWeight(e.target.value)} style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("progressTargetDate")}</span>
            <input id="onb-target-date" type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }} />
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[8, 12, 16].map((n) => (
              <button key={n} type="button" onClick={() => quickWeeks(n)}>{t("progressQuickWeeks").replace("{n}", String(n))}</button>
            ))}
          </div>
          {targetHint && <span style={{ color: "var(--warning, #b7791f)", fontSize: 13 }}>{targetHint}</span>}
        </section>
      )}

      {step === 3 && (
        <section style={{ display: "grid", gap: 8 }}>
          <h1>{t("onboardingStep3Title")}</h1>
          {fromHealth.has("activity") && <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>{t("healthFromTag")}</p>}
          {ACTIVITY_OPTIONS.map((opt) => (
            <OptionButton key={opt.value} selected={activityLevel === opt.value} onClick={() => setActivityLevel(opt.value)}>
              {t(opt.labelKey)}
            </OptionButton>
          ))}
        </section>
      )}

      {step === 4 && (
        <section style={{ display: "grid", gap: 8 }}>
          <h1>{t("onboardingStep4Title")}</h1>
          {fromHealth.has("workouts") && <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>{t("healthFromTag")}</p>}
          <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>{t("multiSelectHint")}</p>
          {WORKOUT_OPTIONS.map((opt) => (
            <OptionButton key={opt.value} selected={workoutTypes.includes(opt.value)} onClick={() => toggleWorkoutType(opt.value)}>
              {t(opt.labelKey)}
            </OptionButton>
          ))}
          {workoutTypes.includes("other") && (
            <div style={{ display: "grid", gap: 8, marginTop: 4 }}>
              <textarea
                value={otherWorkoutText}
                onChange={(e) => setOtherWorkoutText(e.target.value)}
                placeholder={t("otherDescribePlaceholder")}
                rows={2}
                style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
              />
              <button
                type="button"
                onClick={() =>
                  matchOther(
                    otherWorkoutText,
                    WORKOUT_OPTIONS,
                    (matched) => setWorkoutTypes((prev) => Array.from(new Set([...prev, ...matched]))),
                    setMatchingWorkout,
                    () => setOtherWorkoutText(""),
                    setOtherWorkoutMessage,
                  )
                }
                disabled={matchingWorkout || !otherWorkoutText.trim()}
              >
                {matchingWorkout ? t("working") : t("matchCategory")}
              </button>
              {otherWorkoutMessage && <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>{otherWorkoutMessage}</p>}
            </div>
          )}
        </section>
      )}

      {step === 5 && (
        <section style={{ display: "grid", gap: 8 }}>
          <h1>{t("onboardingStep5Title")}</h1>
          <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>{t("multiSelectHint")}</p>
          {DIET_OPTIONS.map((opt) => (
            <OptionButton key={opt.value} selected={dietaryPrefs.includes(opt.value)} onClick={() => toggleDietaryPref(opt.value)}>
              {t(opt.labelKey)}
            </OptionButton>
          ))}
          {dietaryPrefs.includes("other") && (
            <div style={{ display: "grid", gap: 8, marginTop: 4 }}>
              <textarea
                value={otherDietText}
                onChange={(e) => setOtherDietText(e.target.value)}
                placeholder={t("otherDescribePlaceholder")}
                rows={2}
                style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
              />
              <button
                type="button"
                onClick={() =>
                  matchOther(
                    otherDietText,
                    DIET_OPTIONS,
                    (matched) => setDietaryPrefs((prev) => Array.from(new Set([...prev, ...matched]))),
                    setMatchingDiet,
                    () => setOtherDietText(""),
                    setOtherDietMessage,
                  )
                }
                disabled={matchingDiet || !otherDietText.trim()}
              >
                {matchingDiet ? t("working") : t("matchCategory")}
              </button>
              {otherDietMessage && <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>{otherDietMessage}</p>}
            </div>
          )}
          <h2 style={{ margin: "12px 0 0" }}>{t("dietStyleTitle")}</h2>
          <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>{t("dietStyleHint")}</p>
          <div style={{ display: "grid", gap: 8 }}>
            {DIET_STYLES.filter((d) => d !== "custom").map((d) => (
              <OptionButton key={d} selected={dietStyle === d} onClick={() => setDietStyle(d)}>
                {t(`dietStyle_${d}` as "dietStyle_balanced")}
              </OptionButton>
            ))}
          </div>
        </section>
      )}

      {step === 6 && (
        <section style={{ display: "grid", gap: 12 }}>
          <h1>{t("onboardingStepsTitle")}</h1>
          {fromHealth.has("steps") && <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>{t("healthFromTag")}</p>}
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("averageDailyStepsLabel")}</span>
            <input
              type="number"
              min={0}
              value={averageDailySteps}
              onChange={(e) => setAverageDailySteps(Number(e.target.value) || 0)}
              style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
            />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("stepsGoalOnboardingLabel")}</span>
            <input
              type="number"
              min={0}
              value={stepGoal}
              onChange={(e) => setStepGoal(Number(e.target.value) || 0)}
              style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
            />
          </label>
          <h2 style={{ margin: "12px 0 0" }}>{t("onboardingWaterTitle")}</h2>
          <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>{t("onboardingWaterHint")}</p>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("waterGoalLabel")}</span>
            <input id="onb-water-goal" type="number" inputMode="numeric" min={500} max={8000} step={250} value={waterGoal ?? defaultWaterGoalMl(weight)} onChange={(e) => setWaterGoal(Number(e.target.value) || null)} style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }} />
            <span style={{ color: "var(--muted)", fontSize: 12 }}>{t("waterGoalHint")}</span>
          </label>
        </section>
      )}

      {step === 7 && (
        <section style={{ display: "grid", gap: 12 }}>
          <h1>{t("onboardingFinalTitle")}</h1>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="card" style={{ background: "var(--calories-bg)", border: "none" }}>
              <div className="metric-label" style={{ color: "var(--calories)" }}>{t("calories")}</div>
              <div className="metric-value" style={{ color: "var(--calories)" }}>{calculated.calorieGoal}</div>
            </div>
            <div className="card" style={{ background: "var(--protein-bg)", border: "none" }}>
              <div className="metric-label" style={{ color: "var(--protein)" }}>{t("protein")}</div>
              <div className="metric-value" style={{ color: "var(--protein)" }}>
                <bdi dir="ltr">
                  {calculated.proteinGoal}
                  {t("unitG")}
                </bdi>
              </div>
            </div>
          </div>
          <div className="card" style={{ display: "grid", gap: 8 }}>
            <div>
              <span className="metric-label">{t("bmrLabel")}</span>
              <div className="metric-value">{calculated.bmr}</div>
            </div>
            <div>
              <span className="metric-label">{t("tdeeLabel")}</span>
              <div className="metric-value">{calculated.tdee}</div>
            </div>
            <div style={{ color: "var(--muted)", fontSize: 13 }}>
              <bdi dir="ltr">
                {t("carbs")}: {calculated.carbGoal}
                {t("unitG")} · {t("fat")}: {calculated.fatGoal}
                {t("unitG")}
              </bdi>
            </div>
            <div>
              <span className="metric-label">{t("expectedRateLabel")}</span>
              <div className="metric-value">
                <bdi dir="ltr">
                  {calculated.expectedRateKgPerWeek > 0 ? "+" : ""}
                  {calculated.expectedRateKgPerWeek} {t("kgPerWeek")}
                </bdi>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={confirmAndSave} disabled={busy}>
              {busy ? t("working") : t("confirmAndSave")}
            </button>
            <button onClick={() => setStep(1)} disabled={busy} style={{ background: "none", color: "var(--muted)" }}>
              {t("edit")}
            </button>
          </div>
        </section>
      )}

      {step < TOTAL_STEPS && (
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 24 }}>
          <button onClick={() => setStep((s) => Math.max(1, s - 1))} disabled={step === 1} style={{ background: "none", color: "var(--muted)" }}>
            {t("back")}
          </button>
          <button onClick={() => { if (step === 2 && !targetIsSafe()) return; setStep((s) => Math.min(TOTAL_STEPS, s + 1)); }}>{t("next")}</button>
        </div>
      )}
    </main>
  );
}

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
import { useState } from "react";
import { useRouter } from "next/navigation";
import { doc, setDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/useAuth";
import { useI18n } from "@/lib/i18n/useI18n";
import type { StringKey } from "@/lib/i18n/strings";
import { calculateBmr, calculateGoals, calculateTdee } from "@/lib/goals/calculate";
import type {
  ActivityLevel,
  DietaryPref,
  Goal,
  UserProfile,
  WorkoutType,
} from "@/lib/types";

const TOTAL_STEPS = 6;

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
  { value: "cycling", labelKey: "workoutCycling" },
  { value: "swimming", labelKey: "workoutSwimming" },
  { value: "yoga", labelKey: "workoutYoga" },
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
  const { user, loading: authLoading, signIn } = useAuth();
  const { t } = useI18n();
  const router = useRouter();

  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);

  const [age, setAge] = useState(30);
  const [gender, setGender] = useState<UserProfile["gender"]>("male");
  const [height, setHeight] = useState(175);
  const [weight, setWeight] = useState(75);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [activityLevel, setActivityLevel] = useState<ActivityLevel>("moderate");
  const [workoutTypes, setWorkoutTypes] = useState<WorkoutType[]>([]);
  const [dietaryPrefs, setDietaryPrefs] = useState<DietaryPref[]>(["everything"]);

  const [otherWorkoutText, setOtherWorkoutText] = useState("");
  const [matchingWorkout, setMatchingWorkout] = useState(false);
  const [otherDietText, setOtherDietText] = useState("");
  const [matchingDiet, setMatchingDiet] = useState(false);

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
  ) {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) return;
      const categories = options.filter((o) => o.value !== "other").map((o) => ({ value: o.value, label: t(o.labelKey) }));
      const res = await fetch("/api/onboarding/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ text, categories }),
      });
      if (!res.ok) return;
      const data: { matched: string[] } = await res.json();
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
        onboarded: true,
        updatedAt: now,
      };
      await setDoc(ref, update, { merge: true });
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
        </section>
      )}

      {step === 3 && (
        <section style={{ display: "grid", gap: 8 }}>
          <h1>{t("onboardingStep3Title")}</h1>
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
                onClick={() => matchOther(otherWorkoutText, WORKOUT_OPTIONS, (matched) => {
                  setWorkoutTypes((prev) => Array.from(new Set([...prev, ...matched])));
                }, setMatchingWorkout)}
                disabled={matchingWorkout || !otherWorkoutText.trim()}
              >
                {matchingWorkout ? t("working") : t("matchCategory")}
              </button>
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
                onClick={() => matchOther(otherDietText, DIET_OPTIONS, (matched) => {
                  setDietaryPrefs((prev) => Array.from(new Set([...prev, ...matched])));
                }, setMatchingDiet)}
                disabled={matchingDiet || !otherDietText.trim()}
              >
                {matchingDiet ? t("working") : t("matchCategory")}
              </button>
            </div>
          )}
        </section>
      )}

      {step === 6 && (
        <section style={{ display: "grid", gap: 12 }}>
          <h1>{t("onboardingFinalTitle")}</h1>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="card" style={{ background: "var(--calories-bg)", border: "none" }}>
              <div className="metric-label" style={{ color: "var(--calories)" }}>{t("calories")}</div>
              <div className="metric-value" style={{ color: "var(--calories)" }}>{calculated.calorieGoal}</div>
            </div>
            <div className="card" style={{ background: "var(--protein-bg)", border: "none" }}>
              <div className="metric-label" style={{ color: "var(--protein)" }}>{t("protein")}</div>
              <div className="metric-value" style={{ color: "var(--protein)" }}>{calculated.proteinGoal}g</div>
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
                {t("carbs")}: {calculated.carbGoal}g · {t("fat")}: {calculated.fatGoal}g
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
          <button onClick={() => setStep((s) => Math.min(TOTAL_STEPS, s + 1))}>{t("next")}</button>
        </div>
      )}
    </main>
  );
}

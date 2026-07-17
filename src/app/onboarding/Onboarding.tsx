"use client";

/**
 * Onboarding wizard: one question per screen, progress bar at top, final
 * calculated-profile confirmation screen. Re-runnable from Profile →
 * "Recalculate goals from formula".
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { doc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
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

const TOTAL_STEPS = 7;

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

const RATE_OPTIONS: Array<{ value: "gentle" | "moderate" | "aggressive"; labelKey: StringKey }> = [
  { value: "gentle", labelKey: "rateGentle" },
  { value: "moderate", labelKey: "rateModerate" },
  { value: "aggressive", labelKey: "rateAggressive" },
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
  const [goal, setGoal] = useState<Goal>("maintain");
  const [activityLevel, setActivityLevel] = useState<ActivityLevel>("moderate");
  const [workoutTypes, setWorkoutTypes] = useState<WorkoutType[]>([]);
  const [dietaryPref, setDietaryPref] = useState<DietaryPref>("everything");
  const [changeRate, setChangeRate] = useState<"gentle" | "moderate" | "aggressive">("moderate");

  function toggleWorkoutType(value: WorkoutType) {
    setWorkoutTypes((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  }

  const bmr = calculateBmr({ gender: gender ?? "other", weightKg: weight, heightCm: height, age });
  const tdee = calculateTdee(bmr, activityLevel);
  const calculated = calculateGoals({ bmr, tdee, goal, weightKg: weight, dietaryPrefs: [dietaryPref] });

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
        goal,
        activityLevel,
        workoutTypes,
        dietaryPrefs: [dietaryPref],
        changeRate,
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

  function OptionButton<T extends string>({
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
            <input type="number" value={age} onChange={(e) => setAge(Number(e.target.value))} style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }} />
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
            <input type="number" value={height} onChange={(e) => setHeight(Number(e.target.value))} style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("weightLabel")}</span>
            <input type="number" value={weight} onChange={(e) => setWeight(Number(e.target.value))} style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }} />
          </label>
        </section>
      )}

      {step === 2 && (
        <section style={{ display: "grid", gap: 8 }}>
          <h1>{t("onboardingStep2Title")}</h1>
          {GOAL_OPTIONS.map((opt) => (
            <OptionButton key={opt.value} selected={goal === opt.value} onClick={() => setGoal(opt.value)}>
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
          {WORKOUT_OPTIONS.map((opt) => (
            <OptionButton key={opt.value} selected={workoutTypes.includes(opt.value)} onClick={() => toggleWorkoutType(opt.value)}>
              {t(opt.labelKey)}
            </OptionButton>
          ))}
        </section>
      )}

      {step === 5 && (
        <section style={{ display: "grid", gap: 8 }}>
          <h1>{t("onboardingStep5Title")}</h1>
          {DIET_OPTIONS.map((opt) => (
            <OptionButton key={opt.value} selected={dietaryPref === opt.value} onClick={() => setDietaryPref(opt.value)}>
              {t(opt.labelKey)}
            </OptionButton>
          ))}
        </section>
      )}

      {step === 6 && (
        <section style={{ display: "grid", gap: 8 }}>
          <h1>{t("onboardingStep6Title")}</h1>
          {RATE_OPTIONS.map((opt) => (
            <OptionButton key={opt.value} selected={changeRate === opt.value} onClick={() => setChangeRate(opt.value)}>
              {t(opt.labelKey)}
            </OptionButton>
          ))}
          {changeRate === "aggressive" && (
            <p style={{ color: "var(--calories)", fontSize: 13 }}>{t("rateWarning")}</p>
          )}
        </section>
      )}

      {step === 7 && (
        <section style={{ display: "grid", gap: 12 }}>
          <h1>{t("onboardingFinalTitle")}</h1>
          <div className="card" style={{ display: "grid", gap: 8 }}>
            <div>
              <span className="metric-label">{t("bmrLabel")}</span>
              <div className="metric-value">{calculated.bmr}</div>
            </div>
            <div>
              <span className="metric-label">{t("tdeeLabel")}</span>
              <div className="metric-value">{calculated.tdee}</div>
            </div>
            <div>
              <span className="metric-label">{t("calories")}</span>
              <div className="metric-value" style={{ color: "var(--calories)" }}>{calculated.calorieGoal}</div>
            </div>
            <div>
              <span className="metric-label">{t("protein")}</span>
              <div className="metric-value" style={{ color: "var(--protein)" }}>{calculated.proteinGoal}g</div>
            </div>
            <div style={{ color: "var(--muted)", fontSize: 13 }}>
              {t("carbs")}: {calculated.carbGoal}g · {t("fat")}: {calculated.fatGoal}g
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

      {step < 7 && (
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

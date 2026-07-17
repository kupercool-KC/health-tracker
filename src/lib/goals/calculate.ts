/**
 * Pure BMR/TDEE/goal math for the onboarding wizard. No Firestore/network
 * dependency — everything here is a plain function of its inputs, per the
 * spec's "Goal calculation logic" section.
 */
import type { ActivityLevel, DietaryPref, Goal } from "@/lib/types";

export interface BmrInput {
  gender: "male" | "female" | "other";
  weightKg: number;
  heightCm: number;
  age: number;
}

/**
 * Mifflin-St Jeor. The spec only gives male/female branches; for "other" we
 * average the two sex-specific constants (+5 / -161) rather than force a
 * binary choice — a reasonable default, not a literal spec requirement.
 */
export function calculateBmr({ gender, weightKg, heightCm, age }: BmrInput): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  if (gender === "male") return base + 5;
  if (gender === "female") return base - 161;
  return base + (5 + -161) / 2;
}

const ACTIVITY_MULTIPLIERS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  intense: 1.725,
  veryIntense: 1.9,
};

export function calculateTdee(bmr: number, activityLevel: ActivityLevel): number {
  return bmr * ACTIVITY_MULTIPLIERS[activityLevel];
}

const CALORIE_ADJUSTMENT: Record<Goal, number> = {
  buildMuscle: 250, // spec: +200 to +300, midpoint
  cut: -200,
  loseWeight: -500,
  maintain: 0,
};

/** g protein per kg bodyweight, spec ranges' midpoints. */
const PROTEIN_PER_KG: Record<Goal, number> = {
  buildMuscle: 2.0, // 1.8-2.2
  cut: 2.2, // 2.0-2.4
  loseWeight: 1.8, // 1.6-2.0
  maintain: 1.5, // 1.4-1.6
};

export interface CalculatedGoals {
  bmr: number;
  tdee: number;
  calorieGoal: number;
  proteinGoal: number;
  carbGoal: number;
  fatGoal: number;
  /** Derived from the calorie deficit/surplus itself, not asked as a separate
   *  question — negative means losing weight, positive means gaining. */
  expectedRateKgPerWeek: number;
}

export interface GoalsInput {
  bmr: number;
  tdee: number;
  /** One or more goals (multi-select) — e.g. buildMuscle + loseWeight for recomposition. */
  goals: Goal[];
  weightKg: number;
  dietaryPrefs: DietaryPref[];
}

/** Standard approximation: ~7700 kcal of net energy balance per kg of body fat. */
const KCAL_PER_KG_BODY_FAT = 7700;

export function calculateGoals({ bmr, tdee, goals, weightKg, dietaryPrefs }: GoalsInput): CalculatedGoals {
  const selected = goals.length > 0 ? goals : (["maintain"] as Goal[]);

  // Multiple goals selected (e.g. body recomposition): average the calorie
  // adjustment, but take the highest protein target — protein needs from
  // any one goal don't go away just because another goal is also selected.
  const avgCalorieAdjustment = selected.reduce((sum, g) => sum + CALORIE_ADJUSTMENT[g], 0) / selected.length;
  const calorieGoal = Math.round(tdee + avgCalorieAdjustment);

  let proteinPerKg = Math.max(...selected.map((g) => PROTEIN_PER_KG[g]));
  if (dietaryPrefs.includes("vegan")) {
    // Spec: "Vegan: add 10% to protein target (lower bioavailability from plant sources)."
    proteinPerKg *= 1.1;
  }
  const proteinGoal = Math.round(proteinPerKg * weightKg);

  // Spec only says "estimated" for carbs/fat — no formula given. Fill the
  // calories left after protein, split evenly between carbs (4 kcal/g) and
  // fat (9 kcal/g). A defensible default, not a literal spec requirement.
  const remainingKcal = Math.max(0, calorieGoal - proteinGoal * 4);
  const carbGoal = Math.round((remainingKcal * 0.5) / 4);
  const fatGoal = Math.round((remainingKcal * 0.5) / 9);

  const weeklyDeltaKcal = (calorieGoal - tdee) * 7;
  const expectedRateKgPerWeek = Math.round((weeklyDeltaKcal / KCAL_PER_KG_BODY_FAT) * 100) / 100;

  return {
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    calorieGoal,
    proteinGoal,
    carbGoal,
    fatGoal,
    expectedRateKgPerWeek,
  };
}

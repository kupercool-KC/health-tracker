/**
 * Shared (client + server) nutrient logic: daily targets per eating style, plausibility checks
 * on a parsed meal item, day totals and per-nutrient status. No imports from server-only modules.
 */
import type { DietStyle, MealEntry, NutrientTargets, UserProfile } from "@/lib/types";

export type NutrientKey = "carbs" | "fat" | "fiber" | "sugar" | "saturatedFat" | "sodium";
/** "min": aim to reach it (fiber, and carbs only as a floor is not used). "max": stay under it. "target": land near it (carbs, fat). */
export type NutrientKind = "min" | "max" | "target";

export const NUTRIENTS: { key: NutrientKey; unit: "g" | "mg"; kind: NutrientKind }[] = [
  { key: "carbs", unit: "g", kind: "target" },
  { key: "fat", unit: "g", kind: "target" },
  { key: "fiber", unit: "g", kind: "min" },
  { key: "sugar", unit: "g", kind: "max" },
  { key: "saturatedFat", unit: "g", kind: "max" },
  { key: "sodium", unit: "mg", kind: "max" },
];

export const DIET_STYLES: DietStyle[] = ["balanced", "lowCarb", "highProtein", "mediterranean", "keto", "custom"];

/** Fat share of calories / carb share per style; carbs fall out as "the rest" unless fixed. */
const STYLE_SPLIT: Record<Exclude<DietStyle, "custom">, { fatPct: number; carbPct?: number; carbMaxG?: number }> = {
  balanced: { fatPct: 0.3 },
  lowCarb: { fatPct: 0, carbPct: 0.2 },
  keto: { fatPct: 0, carbMaxG: 50 },
  highProtein: { fatPct: 0.25 },
  mediterranean: { fatPct: 0.35 },
};

/** Targets derived from the calorie goal, protein goal and eating style. All values rounded to sensible steps. */
export function computeAutoTargets(calorieGoal: number, proteinGoal: number, style: DietStyle = "balanced"): NutrientTargets {
  const kcal = Math.max(1000, calorieGoal);
  const split = STYLE_SPLIT[style === "custom" ? "balanced" : style];
  const proteinKcal = proteinGoal * 4;
  let carbsG: number;
  let fatG: number;
  if (split.carbMaxG != null) {
    carbsG = split.carbMaxG;
    fatG = (kcal - proteinKcal - carbsG * 4) / 9;
  } else if (split.carbPct != null) {
    carbsG = (kcal * split.carbPct) / 4;
    fatG = (kcal - proteinKcal - carbsG * 4) / 9;
  } else {
    fatG = (kcal * split.fatPct) / 9;
    carbsG = (kcal - proteinKcal - fatG * 9) / 4;
  }
  const r5 = (n: number) => Math.max(0, Math.round(n / 5) * 5);
  return {
    carbsG: r5(carbsG),
    fatG: r5(fatG),
    fiberG: Math.round((kcal / 1000) * 14),
    sugarMaxG: r5((kcal * 0.1) / 4),
    satFatMaxG: r5((kcal * 0.1) / 9),
    sodiumMaxMg: 2300,
    source: "auto",
  };
}

/** The targets to use for a profile: manual ones as saved, otherwise freshly derived (so goal changes flow through). */
export function resolveTargets(profile: Pick<UserProfile, "calorieGoal" | "proteinGoal" | "dietStyle" | "nutrientTargets" | "carbGoal" | "fatGoal">): NutrientTargets {
  if (profile.nutrientTargets?.source === "manual") return profile.nutrientTargets;
  const auto = computeAutoTargets(profile.calorieGoal, profile.proteinGoal, profile.dietStyle);
  // With the default "balanced" style, carb/fat goals set during onboarding/profile keep winning; any other style defines them itself.
  const styleDefines = profile.dietStyle != null && profile.dietStyle !== "balanced";
  return styleDefines ? auto : { ...auto, carbsG: profile.carbGoal ?? auto.carbsG, fatG: profile.fatGoal ?? auto.fatG };
}

export interface NutrientItem {
  calories: number;
  protein: number;
  carbs?: number;
  fat?: number;
  fiber?: number;
  sugar?: number;
  saturatedFat?: number;
  sodium?: number;
}

/**
 * Plausibility check on one parsed item. Drops (sets undefined) any nutrient that breaks a hard rule and
 * reports whether the macro energy (4P+4C+9F) disagrees with the stated calories by more than 25%.
 */
export function validateNutrients<T extends NutrientItem>(item: T, opts: { hasAlcohol?: boolean } = {}): { item: T; dropped: NutrientKey[]; energyMismatch: boolean } {
  const out = { ...item };
  const dropped: NutrientKey[] = [];
  const drop = (k: NutrientKey) => {
    (out as NutrientItem)[k] = undefined;
    dropped.push(k);
  };
  if (out.sodium != null && (out.sodium < 0 || out.sodium > 5000)) drop("sodium");
  if (out.carbs != null && out.carbs > Math.max(5, (out.calories / 4) * 1.15)) drop("carbs");
  if (out.fat != null && out.fat > Math.max(3, (out.calories / 9) * 1.15)) drop("fat");
  if (out.sugar != null && item.carbs != null && out.sugar > item.carbs * 1.05 + 1) drop("sugar");
  if (out.saturatedFat != null && out.fat != null && out.saturatedFat > out.fat * 1.05 + 0.5) drop("saturatedFat");
  if (out.fiber != null && item.carbs != null && out.fiber > item.carbs * 1.05 + 1) drop("fiber");
  let energyMismatch = false;
  if (!opts.hasAlcohol && out.calories >= 50 && out.carbs != null && out.fat != null) {
    const macroKcal = out.protein * 4 + out.carbs * 4 + out.fat * 9;
    energyMismatch = Math.abs(macroKcal - out.calories) > out.calories * 0.25;
  }
  return { item: out, dropped, energyMismatch };
}

export type NutrientStatus = "below" | "inRange" | "above" | "noData";

export function statusFor(kind: NutrientKind, value: number, target: number): NutrientStatus {
  if (target <= 0) return "noData";
  const ratio = value / target;
  if (kind === "max") return ratio > 1 ? "above" : "inRange";
  if (kind === "min") return ratio < 0.8 ? "below" : "inRange";
  return ratio < 0.85 ? "below" : ratio > 1.15 ? "above" : "inRange";
}

export interface DayNutrientTotals {
  totals: Record<NutrientKey, number>;
  /** Meals that carry the new nutrients (sugar/saturatedFat/sodium present) vs all meals of the day. */
  coveredMeals: number;
  totalMeals: number;
}

export function sumDayNutrients(entries: Pick<MealEntry, NutrientKey>[]): DayNutrientTotals {
  const totals: Record<NutrientKey, number> = { carbs: 0, fat: 0, fiber: 0, sugar: 0, saturatedFat: 0, sodium: 0 };
  let covered = 0;
  for (const e of entries) {
    for (const { key } of NUTRIENTS) totals[key] += e[key] ?? 0;
    if (e.sodium != null && e.sugar != null && e.saturatedFat != null) covered++;
  }
  return { totals, coveredMeals: covered, totalMeals: entries.length };
}

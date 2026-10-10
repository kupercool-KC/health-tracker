"use client";

import { useI18n } from "@/lib/i18n/useI18n";
import { NUTRIENTS, resolveTargets, statusFor, sumDayNutrients, type NutrientKey } from "@/lib/nutrition/nutrients";
import type { MealEntry, UserProfile } from "@/lib/types";

type GoalsLike = Pick<UserProfile, "calorieGoal" | "proteinGoal" | "dietStyle" | "nutrientTargets" | "carbGoal" | "fatGoal">;

const LABEL: Record<NutrientKey, "carbs" | "fat" | "fiber" | "nutrientSugar" | "nutrientSatFat" | "nutrientSodium"> = {
  carbs: "carbs",
  fat: "fat",
  fiber: "fiber",
  sugar: "nutrientSugar",
  saturatedFat: "nutrientSatFat",
  sodium: "nutrientSodium",
};

/** Daily average per nutrient over the selected range vs target, counting only days that have full nutrient data. */
export default function NutrientAverages({ days, goals }: { days: { date: string; entries: MealEntry[] }[]; goals: GoalsLike }) {
  const { t } = useI18n();
  const covered = days.map((d) => sumDayNutrients(d.entries)).filter((d) => d.coveredMeals > 0);
  if (covered.length === 0) return null;

  const targets = resolveTargets(goals);
  const targetOf: Record<NutrientKey, number> = {
    carbs: targets.carbsG,
    fat: targets.fatG,
    fiber: targets.fiberG,
    sugar: targets.sugarMaxG,
    saturatedFat: targets.satFatMaxG,
    sodium: targets.sodiumMaxMg,
  };

  return (
    <div className="card" style={{ marginTop: 16, display: "grid", gap: 10 }}>
      <div style={{ fontSize: 12, color: "var(--muted)" }}>{t("nutrientHistoryTitle")}</div>
      {NUTRIENTS.map(({ key, unit, kind }) => {
        const avg = covered.reduce((s, d) => s + d.totals[key], 0) / covered.length;
        const target = targetOf[key];
        const status = statusFor(kind, avg, target);
        const color = status === "above" ? "var(--danger)" : status === "below" ? "var(--warning, #b7791f)" : "var(--burned)";
        return (
          <div key={key} style={{ display: "grid", gap: 3 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, gap: 8 }}>
              <span>{t(LABEL[key])}</span>
              <bdi dir="ltr" style={{ color: "var(--muted)" }}>
                {Math.round(avg)} / {kind === "min" ? "≥" : kind === "max" ? "≤" : ""}
                {target} {unit === "mg" ? t("unitMg") : t("unitG")}
              </bdi>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: "var(--line)", overflow: "hidden" }} role="presentation">
              <div style={{ width: `${Math.min(100, Math.round((target > 0 ? avg / target : 0) * 100))}%`, height: "100%", background: color }} />
            </div>
          </div>
        );
      })}
      <span style={{ color: "var(--muted)", fontSize: 12 }}>
        {t("nutrientCoverage").replace("{n}", String(covered.length)).replace("{m}", String(days.filter((d) => d.entries.length > 0).length))}
      </span>
    </div>
  );
}

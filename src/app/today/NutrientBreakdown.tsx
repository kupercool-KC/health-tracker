"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/useI18n";
import {
  NUTRIENTS,
  resolveTargets,
  statusFor,
  sumDayNutrients,
  type NutrientKey,
  type NutrientStatus,
} from "@/lib/nutrition/nutrients";
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

function statusColor(s: NutrientStatus): string {
  return s === "above" ? "var(--danger)" : s === "below" ? "var(--warning, #b7791f)" : "var(--burned)";
}

/** Collapsible daily nutrient card: three chips for the nutrients furthest from target; expand for a bar per nutrient. */
export default function NutrientBreakdown({ entries, goals }: { entries: MealEntry[]; goals: GoalsLike }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;

  const targets = resolveTargets(goals);
  const day = sumDayNutrients(entries);
  if (day.coveredMeals === 0) {
    return (
      <section style={{ marginTop: 16 }}>
        <div className="card" style={{ display: "grid", gap: 4 }}>
          <strong>{t("nutrientBreakdownTitle")}</strong>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("nutrientEmpty")}</span>
        </div>
      </section>
    );
  }

  const targetOf: Record<NutrientKey, number> = {
    carbs: targets.carbsG,
    fat: targets.fatG,
    fiber: targets.fiberG,
    sugar: targets.sugarMaxG,
    saturatedFat: targets.satFatMaxG,
    sodium: targets.sodiumMaxMg,
  };
  const rows = NUTRIENTS.map(({ key, unit, kind }) => {
    const value = day.totals[key];
    const target = targetOf[key];
    // Early in the day a "below" status for a floor/target nutrient is expected, so only over-limit values count as off-track in the chips.
    const status = statusFor(kind, value, target);
    return { key, unit, kind, value, target, status, ratio: target > 0 ? value / target : 0 };
  });
  const flagged = rows
    .filter((r) => r.status === "above" || (r.kind === "min" && r.status === "below" && day.totalMeals >= 3))
    .sort((a, b) => Math.abs(b.ratio - 1) - Math.abs(a.ratio - 1))
    .slice(0, 3);

  const coverage = t("nutrientCoverage").replace("{n}", String(day.coveredMeals)).replace("{m}", String(day.totalMeals));

  return (
    <section style={{ marginTop: 16 }}>
      <div className="card" style={{ display: "grid", gap: 10 }}>
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={{ all: "unset", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}
        >
          <strong>{t("nutrientBreakdownTitle")}</strong>
          <span aria-hidden style={{ color: "var(--muted)" }}>{open ? "−" : "+"}</span>
        </button>

        {!open && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {flagged.length === 0 ? (
              <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("nutrientAllOnTrack")}</span>
            ) : (
              flagged.map((r) => (
                <span
                  key={r.key}
                  style={{ fontSize: 12, padding: "2px 10px", borderRadius: 99, border: `1px solid ${statusColor(r.status)}`, color: statusColor(r.status) }}
                >
                  {t(LABEL[r.key])} {r.status === "above" ? t("nutrientHigh") : t("nutrientLow")}
                </span>
              ))
            )}
          </div>
        )}

        {open && (
          <div style={{ display: "grid", gap: 10 }}>
            {rows.map((r) => (
              <div key={r.key} style={{ display: "grid", gap: 3 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, gap: 8 }}>
                  <span>{t(LABEL[r.key])}</span>
                  <bdi dir="ltr" style={{ color: "var(--muted)" }}>
                    {Math.round(r.value)} / {r.kind === "min" ? "≥" : r.kind === "max" ? "≤" : ""}
                    {r.target} {r.unit === "mg" ? t("unitMg") : t("unitG")}
                  </bdi>
                </div>
                <div style={{ height: 6, borderRadius: 3, background: "var(--line)", overflow: "hidden" }} role="presentation">
                  <div style={{ width: `${Math.min(100, Math.round(r.ratio * 100))}%`, height: "100%", background: statusColor(r.status) }} />
                </div>
              </div>
            ))}
            <span style={{ color: "var(--muted)", fontSize: 12 }}>{coverage}</span>
          </div>
        )}
      </div>
    </section>
  );
}

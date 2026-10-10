"use client";

import { useCallback, useEffect, useState } from "react";
import { deleteField, doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/useAuth";
import { useI18n } from "@/lib/i18n/useI18n";
import { DIET_STYLES, computeAutoTargets, resolveTargets } from "@/lib/nutrition/nutrients";
import { defaultWaterGoalMl } from "@/lib/water/water";
import { useFlags } from "@/lib/flags/useFlags";
import type { DietStyle, NutrientTargets, UserProfile } from "@/lib/types";

type ProfileSlice = Pick<UserProfile, "calorieGoal" | "proteinGoal" | "dietStyle" | "nutrientTargets" | "carbGoal" | "fatGoal" | "waterGoalMl" | "weight">;

const FIELDS: { key: keyof Omit<NutrientTargets, "source">; label: "carbs" | "fat" | "fiber" | "nutrientSugar" | "nutrientSatFat" | "nutrientSodium"; unit: "unitG" | "unitMg"; bound?: "nutrientAtLeast" | "nutrientAtMost" }[] = [
  { key: "carbsG", label: "carbs", unit: "unitG" },
  { key: "fatG", label: "fat", unit: "unitG" },
  { key: "fiberG", label: "fiber", unit: "unitG", bound: "nutrientAtLeast" },
  { key: "sugarMaxG", label: "nutrientSugar", unit: "unitG", bound: "nutrientAtMost" },
  { key: "satFatMaxG", label: "nutrientSatFat", unit: "unitG", bound: "nutrientAtMost" },
  { key: "sodiumMaxMg", label: "nutrientSodium", unit: "unitMg", bound: "nutrientAtMost" },
];

/** Profile card: eating style + the daily nutrient targets (automatic unless the user edits a value). */
export default function NutrientTargetsCard() {
  const { user } = useAuth();
  const { t } = useI18n();
  const flags = useFlags();
  const [profile, setProfile] = useState<ProfileSlice | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    const snap = await getDoc(doc(db, "users", user.uid, "meta", "profile"));
    const d = snap.data() as UserProfile | undefined;
    if (d) setProfile({ calorieGoal: d.calorieGoal, proteinGoal: d.proteinGoal, dietStyle: d.dietStyle, nutrientTargets: d.nutrientTargets, carbGoal: d.carbGoal, fatGoal: d.fatGoal, waterGoalMl: d.waterGoalMl, weight: d.weight });
  }, [user]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  if (!user || !profile) return null;
  const targets = resolveTargets(profile);
  const style: DietStyle = profile.dietStyle ?? "balanced";

  async function save(patch: Record<string, unknown>) {
    if (!user) return;
    setBusy(true);
    try {
      await setDoc(doc(db, "users", user.uid, "meta", "profile"), { ...patch, updatedAt: new Date().toISOString() }, { merge: true });
      await load();
    } finally {
      setBusy(false);
    }
  }

  const resetAuto = (nextStyle: DietStyle) =>
    save({
      dietStyle: nextStyle,
      nutrientTargets: computeAutoTargets(profile.calorieGoal, profile.proteinGoal, nextStyle),
      // Onboarding-era carb/fat goals would otherwise override the new style's targets.
      carbGoal: deleteField(),
      fatGoal: deleteField(),
    });

  return (
    <div className="card" style={{ marginTop: 16, display: "grid", gap: 10 }}>
      <h2 style={{ margin: 0 }}>{t("dietStyleTitle")}</h2>
      <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>{t("dietStyleHint")}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {DIET_STYLES.map((s) => (
          <button
            key={s}
            type="button"
            disabled={busy}
            aria-pressed={style === s}
            onClick={() => (s === "custom" ? save({ dietStyle: s, nutrientTargets: { ...targets, source: "manual" } }) : resetAuto(s))}
            style={{
              padding: "6px 12px",
              borderRadius: 99,
              border: style === s ? "1.5px solid var(--protein)" : "0.5px solid var(--border)",
              background: style === s ? "var(--surface-2, transparent)" : "transparent",
              color: style === s ? "var(--protein)" : "inherit",
            }}
          >
            {t(`dietStyle_${s}` as "dietStyle_balanced")}
          </button>
        ))}
      </div>

      {flags.on("water") && (
      <label style={{ display: "grid", gap: 4 }}>
        <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("waterGoalLabel")}</span>
        <input
          id="profile-water-goal"
          type="number"
          inputMode="numeric"
          min={500}
          max={8000}
          step={250}
          key={`water-${profile.waterGoalMl ?? "auto"}`}
          defaultValue={profile.waterGoalMl ?? defaultWaterGoalMl(profile.weight)}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v >= 500 && v <= 8000 && v !== (profile.waterGoalMl ?? defaultWaterGoalMl(profile.weight))) save({ waterGoalMl: v });
          }}
          style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)", maxWidth: 160 }}
        />
        <span style={{ color: "var(--muted)", fontSize: 12 }}>{t("waterGoalHint")}</span>
      </label>
      )}

      <h3 style={{ margin: "6px 0 0", fontSize: 14 }}>{t("nutrientTargetsTitle")}</h3>
      <span style={{ color: "var(--muted)", fontSize: 12 }}>
        {targets.source === "manual" ? t("nutrientTargetsManual") : t("nutrientTargetsAuto")}
      </span>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 }}>
        {FIELDS.map((f) => (
          <label key={f.key} style={{ display: "grid", gap: 4 }}>
            <span style={{ color: "var(--muted)", fontSize: 13 }}>
              {t(f.label)} ({f.bound ? `${t(f.bound)} ` : ""}
              {t(f.unit)})
            </span>
            <input
              type="number"
              min={0}
              defaultValue={targets[f.key] as number}
              key={`${f.key}-${targets[f.key]}-${targets.source}`}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (!Number.isFinite(v) || v < 0 || v === targets[f.key]) return;
                save({ nutrientTargets: { ...targets, [f.key]: v, source: "manual" } });
              }}
              style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
            />
          </label>
        ))}
      </div>
      {targets.source === "manual" && style !== "custom" && (
        <div>
          <button type="button" disabled={busy} onClick={() => resetAuto(style)}>
            {t("nutrientTargetsReset")}
          </button>
        </div>
      )}
    </div>
  );
}

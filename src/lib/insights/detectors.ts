/**
 * Insight detectors: pure functions over the nightly rollups. Each returns a candidate with evidence numbers
 * (the LLM later only PHRASES the chosen candidate; it never invents numbers). A detector needs a minimum amount
 * of logged data before it may speak. Not implemented yet (needs per-meal clock times in dailyStats): late-evening eating.
 */
import { resolveTargets } from "@/lib/nutrition/nutrients";
import { defaultWaterGoalMl } from "@/lib/water/water";
import type { DailyStats, InsightType, MetricsCurrent, UserProfile } from "@/lib/types";

export interface Candidate {
  type: InsightType;
  /** 0..1 — size of the effect. */
  effect: number;
  /** Multiplier by how much it matters for the user's goal (set by the ranker from `goalWeights`). */
  evidence: Record<string, number | string>;
  action?: { kind: "askLily"; promptHe: string; promptEn: string } | { kind: "applyCalorieGoal"; value: number };
  positive?: boolean;
}

interface Ctx {
  /** Feature flags already resolved for this user (e.g. water insights only once the water feature is on for them). */
  features?: { water?: boolean };
  stats: DailyStats[]; // oldest → newest, last 28+ days, today last
  metrics: MetricsCurrent;
  profile: UserProfile;
}

const logged = (xs: DailyStats[]) => xs.filter((d) => d.mealsLogged >= 2);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const isWeekendIL = (date: string) => {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return dow === 5 || dow === 6; // Fri, Sat
};
const r = (n: number) => Math.round(n);

export function detect({ stats, metrics, profile, features }: Ctx): Candidate[] {
  const out: Candidate[] = [];
  const l7 = logged(stats.slice(-7));
  const l28 = logged(stats.slice(-28));
  const targets = resolveTargets(profile);
  const goal = profile.calorieGoal;
  const proteinGoal = profile.proteinGoal;

  // Protein often short.
  if (l7.length >= 5) {
    const hit = l7.filter((d) => d.protein >= proteinGoal * 0.9).length;
    if (hit <= 2) {
      out.push({
        type: "proteinLow",
        effect: 1 - hit / l7.length,
        evidence: { daysHit: hit, daysLogged: l7.length, avgProtein: r(avg(l7.map((d) => d.protein))), goal: proteinGoal },
        action: { kind: "askLily", promptHe: "תציעי לי 3 דרכים קלות להוסיף חלבון מהמנות הקבועות שלי", promptEn: "Suggest 3 easy ways to add protein using my regular foods" },
      });
    }
  }

  // Protein on rest days vs workout days.
  if (l28.length >= 12) {
    const wk = l28.filter((d) => d.workoutCount > 0);
    const rest = l28.filter((d) => d.workoutCount === 0);
    if (wk.length >= 4 && rest.length >= 4) {
      const wkHit = wk.filter((d) => d.protein >= proteinGoal * 0.9).length / wk.length;
      const restHit = rest.filter((d) => d.protein >= proteinGoal * 0.9).length / rest.length;
      if (wkHit - restHit >= 0.35) {
        out.push({
          type: "restDayProtein",
          effect: Math.min(1, wkHit - restHit),
          evidence: { workoutDaysHitPct: r(wkHit * 100), restDaysHitPct: r(restHit * 100) },
          action: { kind: "askLily", promptHe: "תעזרי לי לא לפספס חלבון בימי מנוחה", promptEn: "Help me not miss protein on rest days" },
        });
      }
    }
  }

  // Weekend vs weekday calorie gap.
  if (l28.length >= 14) {
    const we = l28.filter((d) => isWeekendIL(d.date));
    const wd = l28.filter((d) => !isWeekendIL(d.date));
    if (we.length >= 3 && wd.length >= 6) {
      const gap = avg(we.map((d) => d.calories)) - avg(wd.map((d) => d.calories));
      if (gap >= 400) {
        out.push({
          type: "weekendGap",
          effect: Math.min(1, gap / 1000),
          evidence: { weekendAvg: r(avg(we.map((d) => d.calories))), weekdayAvg: r(avg(wd.map((d) => d.calories))), gap: r(gap) },
          action: { kind: "askLily", promptHe: "תעזרי לי לתכנן ארוחה אחת בסוף השבוע מראש", promptEn: "Help me plan one weekend meal ahead" },
        });
      }
    }
  }

  // Plateau: flat trend for 14+ days while the logged balance says deficit.
  const w = metrics.weight;
  if (w && w.weeklyRateKg != null && l28.length >= 14 && profile.goals?.some((g) => g === "cut" || g === "loseWeight")) {
    const recent14 = w.series.filter((p) => p.date >= stats.at(-14)!.date);
    const flat = recent14.length >= 3 && Math.abs(w.weeklyRateKg) < 0.1;
    const deficit = w.expectedChange28Kg != null && w.expectedChange28Kg <= -0.8;
    if (flat && deficit) {
      out.push({
        type: "plateau",
        effect: Math.min(1, Math.abs(w.expectedChange28Kg!) / 3),
        evidence: { weeklyRate: w.weeklyRateKg, expectedChange28: w.expectedChange28Kg!, actualChange28: w.actualChange28Kg ?? 0 },
        action: { kind: "askLily", promptHe: "המשקל תקוע, תעזרי לי להבין למה", promptEn: "My weight has stalled, help me work out why" },
      });
    }
  }

  // Sodium high (needs nutrient coverage).
  {
    const covered = l7.filter((d) => d.nutrientCoveredMeals >= Math.max(1, Math.floor(d.mealsLogged / 2)));
    const above = covered.filter((d) => d.sodium > targets.sodiumMaxMg).length;
    if (covered.length >= 5 && above >= 4) {
      out.push({
        type: "sodiumHigh",
        effect: Math.min(1, avg(covered.map((d) => d.sodium)) / targets.sodiumMaxMg - 0.9),
        evidence: { daysAbove: above, daysLogged: covered.length, avgSodiumMg: r(avg(covered.map((d) => d.sodium))), targetMg: targets.sodiumMaxMg },
        action: { kind: "askLily", promptHe: "תציעי לי החלפות עם פחות מלח מהמנות הקבועות שלי", promptEn: "Suggest lower-salt swaps from my regular foods" },
      });
    }
  }

  // Fiber consistently low.
  {
    const covered = l7.filter((d) => d.nutrientCoveredMeals >= Math.max(1, Math.floor(d.mealsLogged / 2)));
    const low = covered.filter((d) => d.fiber < targets.fiberG * 0.6).length;
    if (covered.length >= 5 && low >= 5) {
      out.push({
        type: "fiberLow",
        effect: 0.4,
        evidence: { daysLow: low, daysLogged: covered.length, avgFiberG: r(avg(covered.map((d) => d.fiber))), targetG: targets.fiberG },
        action: { kind: "askLily", promptHe: "תציעי לי דרכים להוסיף סיבים בלי להרגיש מאמץ", promptEn: "Suggest easy ways to add fiber" },
      });
    }
  }

  // Training drop.
  if (metrics.daysWithData >= 28) {
    const last14 = stats.slice(-14).reduce((s, d) => s + d.workoutCount, 0) / 2;
    const prev = metrics.workoutsPrev28.perWeek;
    if (prev >= 2 && last14 < prev * 0.6) {
      out.push({
        type: "trainingDrop",
        effect: Math.min(1, 1 - last14 / prev),
        evidence: { perWeekNow: Math.round(last14 * 10) / 10, perWeekBefore: prev },
        action: { kind: "askLily", promptHe: "תציעי לי אימון קצר שמתאים לי להשבוע", promptEn: "Suggest a short workout that suits me this week" },
      });
    }
  }

  // Short sleep followed by higher intake.
  {
    let hits = 0;
    for (let i = 1; i < stats.length; i++) {
      const prev = stats[i - 1], cur = stats[i];
      if (prev.sleepAsleepMin && prev.sleepAsleepMin < 360 && cur.mealsLogged >= 2 && cur.calories > goal + 300) hits++;
    }
    if (hits >= 3) {
      out.push({
        type: "sleepIntake",
        effect: Math.min(1, hits / 6),
        evidence: { occasions: hits },
        action: { kind: "askLily", promptHe: "תעזרי לי להתחיל להירדם מוקדם יותר", promptEn: "Help me start going to sleep earlier" },
      });
    }
  }

  // Water consistently low (only for people who actually track it: at least 3 days with an entry in the last 7).
  if (features?.water) {
    const goalMl = profile.waterGoalMl ?? defaultWaterGoalMl(profile.weight);
    const tracked = stats.slice(-7).filter((d) => (d.waterMl ?? 0) > 0);
    const low = tracked.filter((d) => (d.waterMl ?? 0) < goalMl * 0.6).length;
    if (tracked.length >= 3 && low >= 3 && l7.length >= 5) {
      out.push({
        type: "waterLow",
        effect: 0.45,
        evidence: { daysLow: low, daysTracked: tracked.length, avgMl: r(avg(tracked.map((d) => d.waterMl ?? 0))), goalMl },
        action: { kind: "askLily", promptHe: "תעזרי לי לזכור לשתות יותר מים במהלך היום", promptEn: "Help me remember to drink more water during the day" },
      });
    }
  }

  // Positives.
  if (l7.length === 7 && l7.every((d) => d.protein >= proteinGoal * 0.9)) {
    out.push({ type: "streak", effect: 0.6, positive: true, evidence: { kind: "protein7of7", days: 7 } });
  } else if (metrics.logging.streak >= 7) {
    out.push({ type: "streak", effect: 0.5, positive: true, evidence: { kind: "logging", days: metrics.logging.streak } });
  }
  if (w?.status === "ahead" && w.progressPct != null) {
    out.push({ type: "aheadOfPlan", effect: 0.55, positive: true, evidence: { progressPct: w.progressPct } });
  }

  // Recalibrate the calorie goal (offered at most about every 4 weeks, only with real data and a target).
  if (w && w.status === "behind" && w.targetKg != null && w.weeklyRateKg != null && l28.length >= 20) {
    const remaining = w.targetKg - w.trendKg;
    const days = w.targetDate ? Math.max(7, Math.round((new Date(`${w.targetDate}T12:00:00Z`).getTime() - Date.now()) / 86_400_000)) : 0;
    const neededRate = days ? (remaining / days) * 7 : 0;
    const gapPerWeek = Math.abs(neededRate) - Math.abs(w.weeklyRateKg);
    if (days && gapPerWeek > 0.1 && Math.abs(gapPerWeek) / Math.max(0.1, Math.abs(neededRate)) > 0.25) {
      const adjust = Math.min(300, Math.round(((gapPerWeek * 7700) / 7) / 25) * 25);
      const bmr = profile.age && profile.height && profile.weight ? 10 * w.latestKg + 6.25 * profile.height - 5 * profile.age + (profile.gender === "male" ? 5 : profile.gender === "female" ? -161 : -78) : 1200;
      const floor = Math.max(1200, Math.round(bmr * 1.1));
      const value = Math.max(floor, goal + (remaining < 0 ? -adjust : adjust));
      if (value !== goal) out.push({ type: "recalibrate", effect: 0.7, evidence: { current: goal, suggested: value, neededRatePerWeek: Math.round(neededRate * 100) / 100, actualRatePerWeek: w.weeklyRateKg }, action: { kind: "applyCalorieGoal", value } });
    }
  }

  return out;
}

/** How much each insight matters for the user's goals (loss goals weigh calories/plateau, muscle goals weigh protein/training). */
export function goalWeight(type: InsightType, goals: UserProfile["goals"] | undefined): number {
  const loss = goals?.some((g) => g === "cut" || g === "loseWeight");
  const muscle = goals?.includes("buildMuscle");
  const w: Partial<Record<InsightType, number>> = {
    plateau: loss ? 1.4 : 0.8,
    weekendGap: loss ? 1.3 : 0.9,
    recalibrate: 1.5,
    proteinLow: muscle ? 1.4 : 1.1,
    restDayProtein: muscle ? 1.3 : 0.9,
    trainingDrop: muscle ? 1.3 : 1,
    sodiumHigh: 0.8,
    fiberLow: 0.7,
    sleepIntake: 0.8,
    waterLow: 0.8,
    streak: 0.7,
    aheadOfPlan: 0.8,
  };
  return w[type] ?? 1;
}

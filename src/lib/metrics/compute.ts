/**
 * Deterministic metrics engine: rolls the last 90 days into users/{uid}/dailyStats/{date} and
 * users/{uid}/metrics/current. No LLM involved. Server-only (Admin SDK).
 */
import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { calculateBmr, calculateTdee } from "@/lib/goals/calculate";
import { sumDayNutrients } from "@/lib/nutrition/nutrients";
import type { BodyMetricsEntry, DailyStats, MealDay, MetricsCurrent, UserProfile, Workout } from "@/lib/types";

const DAY_MS = 86_400_000;
const KCAL_PER_KG = 7700;
const WINDOW = 90;

export function israelDateKey(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
const shift = (date: string, days: number) => israelDateKey(new Date(new Date(`${date}T12:00:00Z`).getTime() + days * DAY_MS));
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r1 = (n: number) => Math.round(n * 10) / 10;

export async function computeMetrics(uid: string, now = new Date()): Promise<MetricsCurrent | null> {
  const user = adminDb.collection("users").doc(uid);
  const today = israelDateKey(now);
  const from = shift(today, -(WINDOW - 1));

  const [profileSnap, mealSnap, workoutSnap, stepSnap, sleepSnap, vitalSnap, bodySnap] = await Promise.all([
    user.collection("meta").doc("profile").get(),
    user.collection("meals").where("date", ">=", from).get(),
    user.collection("workouts").where("date", ">=", from).get(),
    user.collection("steps").where("date", ">=", from).get(),
    user.collection("sleep").where("date", ">=", from).get(),
    user.collection("vitals").where("date", ">=", from).get(),
    user.collection("bodyMetrics").where("date", ">=", from).get(),
  ]);
  const profile = profileSnap.data() as UserProfile | undefined;
  if (!profile?.onboarded) return null;

  const meals = new Map(mealSnap.docs.map((d) => [d.id, d.data() as MealDay]));
  const workoutsByDate = new Map<string, Workout[]>();
  for (const d of workoutSnap.docs) {
    const w = d.data() as Workout;
    workoutsByDate.set(w.date, [...(workoutsByDate.get(w.date) ?? []), w]);
  }
  const steps = new Map(stepSnap.docs.map((d) => [d.id, (d.data() as { steps: number }).steps]));
  const sleep = new Map(sleepSnap.docs.map((d) => [d.id, (d.data() as { asleepMin: number }).asleepMin]));
  const hr = new Map(vitalSnap.docs.map((d) => [d.id, (d.data() as { restingHr?: number }).restingHr]));
  const body = bodySnap.docs.map((d) => d.data() as BodyMetricsEntry).filter((b) => b.weightKg != null).sort((a, b) => a.date.localeCompare(b.date));

  const burnFactor = (profile.netCalorieBurnFactor ?? 50) / 100;
  const calorieGoal = profile.calorieGoal;
  const proteinGoal = profile.proteinGoal;

  const stats: DailyStats[] = [];
  for (let i = WINDOW - 1; i >= 0; i--) {
    const date = shift(today, -i);
    const day = meals.get(date);
    const entries = day?.entries ?? [];
    const nut = sumDayNutrients(entries);
    const ws = workoutsByDate.get(date) ?? [];
    const burned = Math.round(ws.reduce((s, w) => s + (w.calories ?? 0), 0) * burnFactor);
    const calories = Math.round(day?.totals?.calories ?? 0);
    const weight = body.filter((b) => b.date === date).at(-1)?.weightKg;
    stats.push({
      date,
      calories,
      protein: r1(day?.totals?.protein ?? 0),
      carbs: r1(nut.totals.carbs),
      fat: r1(nut.totals.fat),
      fiber: r1(nut.totals.fiber),
      sugar: r1(nut.totals.sugar),
      saturatedFat: r1(nut.totals.saturatedFat),
      sodium: Math.round(nut.totals.sodium),
      mealsLogged: entries.length,
      nutrientCoveredMeals: nut.coveredMeals,
      burned,
      netCalories: calories - burned,
      workoutCount: ws.length,
      workoutMinutes: Math.round(ws.reduce((s, w) => s + w.duration, 0) / 60),
      ...(steps.has(date) ? { steps: steps.get(date) } : {}),
      ...(weight != null ? { weightKg: weight } : {}),
      ...(sleep.has(date) ? { sleepAsleepMin: sleep.get(date) } : {}),
      ...(hr.get(date) != null ? { restingHr: hr.get(date) } : {}),
      computedAt: now.toISOString(),
    });
  }

  // Persist (idempotent upserts, last 90 days).
  for (let i = 0; i < stats.length; i += 400) {
    const batch = adminDb.batch();
    for (const s of stats.slice(i, i + 400)) batch.set(user.collection("dailyStats").doc(s.date), s);
    await batch.commit();
  }

  const last = (n: number) => stats.slice(-n);
  const logged = (xs: DailyStats[]) => xs.filter((d) => d.mealsLogged >= 2);
  const w7 = last(7), w28 = last(28);
  const l7 = logged(w7), l28 = logged(w28);

  let streak = 0;
  for (let i = stats.length - 1; i >= 0; i--) {
    if (stats[i].mealsLogged >= 2) streak++;
    else if (i === stats.length - 1) continue; // today may still be in progress
    else break;
  }

  const calorieOk = (d: DailyStats) => d.netCalories <= calorieGoal * 1.1 && d.calories >= calorieGoal * 0.6;
  const proteinOk = (d: DailyStats) => d.protein >= proteinGoal * 0.9;
  const optional = (xs: (number | undefined)[]) => {
    const v = xs.filter((x): x is number => x != null && x > 0);
    return v.length ? Math.round(avg(v)) : undefined;
  };
  const avgOf = (xs: DailyStats[], logs: DailyStats[]) => ({
    calories: Math.round(avg(logs.map((d) => d.calories))),
    protein: Math.round(avg(logs.map((d) => d.protein))),
    net: Math.round(avg(logs.map((d) => d.netCalories))),
    ...(optional(xs.map((d) => d.steps)) != null ? { steps: optional(xs.map((d) => d.steps)) } : {}),
    ...(optional(xs.map((d) => d.sleepAsleepMin)) != null ? { sleepMin: optional(xs.map((d) => d.sleepAsleepMin)) } : {}),
  });

  // --- weight trend (EMA over weigh-ins) ---
  let weight: MetricsCurrent["weight"];
  if (body.length > 0) {
    let trend = body[0].weightKg!;
    const series = body.map((b) => {
      trend = trend + 0.3 * (b.weightKg! - trend);
      return { date: b.date, kg: r1(b.weightKg!), trend: r1(trend) };
    });
    const latest = series.at(-1)!;
    const recent = series.filter((p) => p.date >= shift(today, -27));
    let weeklyRateKg: number | undefined;
    if (recent.length >= 2) {
      const t0 = new Date(`${recent[0].date}T12:00:00Z`).getTime();
      const xs = recent.map((p) => (new Date(`${p.date}T12:00:00Z`).getTime() - t0) / (7 * DAY_MS));
      const ys = recent.map((p) => p.trend);
      const mx = avg(xs), my = avg(ys);
      const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
      if (den > 0) weeklyRateKg = r1(xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / den);
    }
    const startKg = profile.startWeightKg ?? series[0].kg;
    const targetKg = profile.targetWeightKg;
    const bmr = profile.age && profile.height && (profile.weight ?? latest.kg)
      ? calculateBmr({ gender: profile.gender ?? "other", weightKg: latest.kg, heightCm: profile.height, age: profile.age })
      : undefined;
    const tdee = bmr && profile.activityLevel ? calculateTdee(bmr, profile.activityLevel) : undefined;

    // Predicted vs actual change over the last 28 days.
    let expectedChange28Kg: number | undefined;
    let actualChange28Kg: number | undefined;
    if (tdee && l28.length >= 10 && recent.length >= 2) {
      const meanBalance = avg(l28.map((d) => tdee - d.netCalories));
      expectedChange28Kg = r1(-(meanBalance * 28) / KCAL_PER_KG);
      actualChange28Kg = r1(recent.at(-1)!.trend - recent[0].trend);
    }

    let etaDate: string | undefined;
    let requiredDailyBalanceKcal: number | undefined;
    let progressPct: number | undefined;
    let status: NonNullable<MetricsCurrent["weight"]>["status"] = "notEnoughData";
    if (targetKg != null) {
      const total = targetKg - startKg;
      progressPct = total !== 0 ? Math.max(0, Math.min(100, Math.round(((latest.trend - startKg) / total) * 100))) : 100;
      const remaining = targetKg - latest.trend;
      if (weeklyRateKg != null && Math.abs(weeklyRateKg) > 0.02 && Math.sign(weeklyRateKg) === Math.sign(remaining)) {
        etaDate = shift(today, Math.round((remaining / weeklyRateKg) * 7));
      }
      if (profile.targetDate) {
        const daysLeft = Math.max(1, Math.round((new Date(`${profile.targetDate}T12:00:00Z`).getTime() - new Date(`${today}T12:00:00Z`).getTime()) / DAY_MS));
        requiredDailyBalanceKcal = Math.round((remaining * KCAL_PER_KG) / daysLeft);
        if (recent.length >= 3 && weeklyRateKg != null) {
          const neededRate = (remaining / daysLeft) * 7;
          const slack = Math.max(0.1, Math.abs(neededRate) * 0.25);
          status = Math.abs(remaining) < 0.3 ? "ahead" : Math.sign(weeklyRateKg) !== Math.sign(neededRate) ? "behind" : Math.abs(weeklyRateKg) >= Math.abs(neededRate) + slack ? "ahead" : Math.abs(weeklyRateKg) >= Math.abs(neededRate) - slack ? "onTrack" : "behind";
        }
      } else if (recent.length >= 3 && weeklyRateKg != null) {
        status = Math.sign(weeklyRateKg) === Math.sign(remaining) ? "onTrack" : "behind";
      }
    }
    weight = {
      startKg: r1(startKg),
      latestKg: latest.kg,
      trendKg: latest.trend,
      ...(weeklyRateKg != null ? { weeklyRateKg } : {}),
      series: series.slice(-60),
      ...(targetKg != null ? { targetKg } : {}),
      ...(profile.targetDate ? { targetDate: profile.targetDate } : {}),
      ...(etaDate ? { etaDate } : {}),
      ...(requiredDailyBalanceKcal != null ? { requiredDailyBalanceKcal } : {}),
      ...(expectedChange28Kg != null ? { expectedChange28Kg, actualChange28Kg } : {}),
      ...(progressPct != null ? { progressPct } : {}),
      status,
    };
  }

  const prev28 = stats.slice(-35, -7);
  const metrics: MetricsCurrent = {
    computedAt: now.toISOString(),
    today,
    logging: { days7: l7.length, days28: l28.length, streak },
    avg7: avgOf(w7, l7),
    avg28: avgOf(w28, l28),
    adherence: {
      calorieDays7: l7.filter(calorieOk).length,
      calorieDays28: l28.filter(calorieOk).length,
      proteinDays7: l7.filter(proteinOk).length,
      proteinDays28: l28.filter(proteinOk).length,
      loggedDays7: l7.length,
      loggedDays28: l28.length,
    },
    ...(weight ? { weight } : {}),
    workouts7: { count: w7.reduce((s, d) => s + d.workoutCount, 0), minutes: w7.reduce((s, d) => s + d.workoutMinutes, 0) },
    workoutsPrev28: { perWeek: r1(prev28.reduce((s, d) => s + d.workoutCount, 0) / 4) },
    daysWithData: stats.filter((d) => d.mealsLogged > 0 || d.workoutCount > 0 || d.steps).length,
  };
  await user.collection("metrics").doc("current").set(metrics);
  return metrics;
}

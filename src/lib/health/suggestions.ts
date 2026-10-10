/** Profile suggestions derived from ~60 days of Apple Health data. Pure; used by the importer. */
import type { ActivityLevel, WorkoutType } from "@/lib/types";
import { activityLevelFromSessions, categoryOfHk, median } from "./workoutMap";

export interface ImportedWorkoutLite {
  hkType: string;
  startTime: string;
  durationSec: number;
}

export interface HealthSuggestions {
  heightCm?: number;
  weightKg?: number;
  bodyFatPercent?: number;
  workoutTypes: WorkoutType[];
  activityLevel?: ActivityLevel;
  averageDailySteps?: number;
  /** Median steps rounded up to the next 500. */
  stepGoal?: number;
  sleepMedianMin?: number;
  restingHr?: number;
  counts: { workouts: number; byCategory: Partial<Record<WorkoutType, number>>; sleepNights: number; stepDays: number };
}

export function buildSuggestions(input: {
  workouts: ImportedWorkoutLite[];
  stepsByDay: number[];
  sleepAsleepMin: number[];
  restingHrByDay: number[];
  latestWeightKg?: number;
  latestBodyFat?: number;
  heightCm?: number;
  spanDays: number;
}): HealthSuggestions {
  const byCategory: Partial<Record<WorkoutType, number>> = {};
  for (const w of input.workouts) {
    const c = categoryOfHk(w.hkType);
    byCategory[c] = (byCategory[c] ?? 0) + 1;
  }
  const workoutTypes = (Object.entries(byCategory) as [WorkoutType, number][])
    .filter(([c, n]) => n >= 2 && c !== "other")
    .sort((a, b) => b[1] - a[1])
    .map(([c]) => c);
  const weeks = Math.max(1, input.spanDays / 7);
  const sessionsPerWeek = input.workouts.length / weeks;
  const stepsMedian = median(input.stepsByDay.filter((s) => s > 0));
  return {
    heightCm: input.heightCm,
    weightKg: input.latestWeightKg,
    bodyFatPercent: input.latestBodyFat,
    workoutTypes,
    activityLevel: input.workouts.length > 0 ? activityLevelFromSessions(sessionsPerWeek) : undefined,
    averageDailySteps: stepsMedian,
    stepGoal: stepsMedian ? Math.ceil(stepsMedian / 500) * 500 : undefined,
    sleepMedianMin: median(input.sleepAsleepMin.filter((m) => m > 0)),
    restingHr: median(input.restingHrByDay.filter((b) => b > 0)),
    counts: { workouts: input.workouts.length, byCategory, sleepNights: input.sleepAsleepMin.length, stepDays: input.stepsByDay.filter((s) => s > 0).length },
  };
}

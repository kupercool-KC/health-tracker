/**
 * Rough estimate of how many of a day's pedometer/phone-tracked steps came
 * from a logged workout, so the daily step goal can optionally be compared
 * against "everyday activity" steps only rather than double-counting a run
 * or walk that's already tracked (and rewarded) as its own workout.
 *
 * Deliberately simple — a fixed cadence (steps/min) or stride length
 * (meters/step) per workout type, not a personalized model. Non-ambulatory
 * types (strength, swimming, cycling, yoga) contribute 0 steps.
 */
import type { Workout } from "@/lib/types";

/** Average stride length in meters, used when a workout has a distance. */
const STRIDE_METERS: Record<string, number> = {
  running: 1.15,
  walking: 0.75,
};

/** Steps per minute, used as a fallback when a workout has no distance (e.g. a treadmill run logged by duration only). */
const CADENCE_STEPS_PER_MIN: Record<string, number> = {
  running: 165,
  walking: 115,
  hiit: 120,
  padel: 90,
};

export function estimateWorkoutSteps(type: string, durationSec: number, distanceMeters?: number): number {
  const key = type.trim().toLowerCase();
  const stride = STRIDE_METERS[key];
  if (distanceMeters && stride) {
    return Math.round(distanceMeters / stride);
  }
  const cadence = CADENCE_STEPS_PER_MIN[key];
  if (!cadence) return 0;
  return Math.round((durationSec / 60) * cadence);
}

export function estimateTotalWorkoutSteps(workouts: Workout[]): number {
  return workouts.reduce((sum, w) => sum + estimateWorkoutSteps(w.type, w.duration, w.distance), 0);
}

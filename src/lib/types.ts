/**
 * Core domain models. These mirror the Firestore layout documented in
 * docs/data-model.md. Timestamps are stored as ISO-8601 strings both at the
 * API boundary and at rest, so range queries can compare them lexically.
 */

/** A single logged food/meal entry parsed from chat or an image. */
export interface NutritionEntry {
  id: string;
  userId: string;
  /** Free-text or "photo" describing what was logged. */
  description: string;
  calories: number;
  /** grams */
  protein: number;
  /** Where this came from, for auditing the parse. */
  source: "chat" | "image";
  /** Model confidence 0..1, when the parser provides one. */
  confidence?: number;
  /** ISO-8601 timestamp of when the food was consumed/logged. */
  loggedAt: string;
  createdAt: string;
}

/** A workout pushed in from Apple Health via the iOS Shortcut. */
export interface Workout {
  id: string;
  userId: string;
  /** e.g. "Running", "Strength Training" — Apple's HKWorkoutActivityType name. */
  activityType: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  activeEnergyKcal?: number;
  distanceMeters?: number;
  averageHeartRate?: number;
  /** Stable id from Health (HKWorkout UUID) used to dedupe re-imports. */
  externalId: string;
  createdAt: string;
}

/** Result of parsing a nutrition input, before it becomes a NutritionEntry. */
export interface ParsedNutrition {
  description: string;
  calories: number;
  protein: number;
  confidence?: number;
}

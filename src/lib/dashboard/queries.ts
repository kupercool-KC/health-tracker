"use client";

/**
 * Client-side Firestore reads for the dashboard. Firestore rules only allow a
 * user to read their own `users/{uid}/**` subtree, so these run with the
 * signed-in user's ID token via the browser SDK (no API route needed).
 *
 * One doc per day (users/{uid}/meals/{date}) makes "today's totals" a single
 * doc read instead of a range query — the old per-entry-doc model needed the
 * range-query + client-side bucketing this file used to do.
 */
import { collection, doc, documentId, getDoc, getDocs, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import type { DailySteps, MealDay, Workout } from "@/lib/types";

const EMPTY_TOTALS = { calories: 0, protein: 0, carbs: 0, fat: 0 };

/**
 * Local (browser timezone) yyyy-mm-dd. Deliberately NOT
 * `toISOString().slice(0, 10)` — that converts to UTC first, which mislabels
 * "today" as yesterday for any timezone ahead of UTC.
 */
export function localDateKey(input: string | Date = new Date()): string {
  const d = typeof input === "string" ? new Date(input) : input;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** yyyy-mm-dd for `daysAgo` days before today, local timezone. */
export function localDateKeyDaysAgo(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return localDateKey(d);
}

export async function getMealDay(uid: string, date: string): Promise<MealDay> {
  const ref = doc(db, "users", uid, "meals", date);
  const snap = await getDoc(ref);
  return (snap.data() as MealDay | undefined) ?? { date, entries: [], totals: { ...EMPTY_TOTALS } };
}

export async function getWorkoutsForDate(uid: string, date: string): Promise<Workout[]> {
  const col = collection(db, "users", uid, "workouts");
  const q = query(col, where("date", "==", date));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as Workout);
}

/**
 * Meal days with doc id (= date) >= sinceDate, optionally also <= untilDate
 * (for a bounded custom range that doesn't necessarily reach today). Doc ids
 * sort lexically, same trick as everywhere else in this file.
 */
export async function getMealDaysSince(uid: string, sinceDate: string, untilDate?: string): Promise<MealDay[]> {
  const col = collection(db, "users", uid, "meals");
  const q = untilDate
    ? query(col, where(documentId(), ">=", sinceDate), where(documentId(), "<=", untilDate))
    : query(col, where(documentId(), ">=", sinceDate));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as MealDay);
}

export async function getWorkoutsSince(uid: string, sinceDate: string, untilDate?: string): Promise<Workout[]> {
  const col = collection(db, "users", uid, "workouts");
  const q = untilDate
    ? query(col, where("date", ">=", sinceDate), where("date", "<=", untilDate))
    : query(col, where("date", ">=", sinceDate));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as Workout);
}

export async function getStepsForDate(uid: string, date: string): Promise<DailySteps | null> {
  const ref = doc(db, "users", uid, "steps", date);
  const snap = await getDoc(ref);
  return (snap.data() as DailySteps | undefined) ?? null;
}

/** Same doc-id-range trick as getMealDaysSince — users/{uid}/steps/{date}, one doc per day. */
export async function getStepsSince(uid: string, sinceDate: string, untilDate?: string): Promise<DailySteps[]> {
  const col = collection(db, "users", uid, "steps");
  const q = untilDate
    ? query(col, where(documentId(), ">=", sinceDate), where(documentId(), "<=", untilDate))
    : query(col, where(documentId(), ">=", sinceDate));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as DailySteps);
}

export interface FrequentMeal {
  name: string;
  count: number;
  avgCalories: number;
  avgProtein: number;
  avgGrams?: number;
}

/**
 * Ranks the user's own logged meals by how often they've logged that exact
 * name, for a "recent/frequent meals" picker — grouping is case/whitespace
 * normalized so "Omelet" and "omelet " count as the same meal, but the most
 * recently-seen casing is what's displayed. Window is short (30 days, not
 * the full history) so this tracks CURRENT habits — a meal eaten daily for
 * a month five months ago but not since would otherwise keep dominating
 * the picker indefinitely purely on raw historical count, never making
 * room for what's actually being eaten now.
 */
export async function getFrequentMeals(uid: string, sinceDaysAgo = 30, limit = 8): Promise<FrequentMeal[]> {
  const days = await getMealDaysSince(uid, localDateKeyDaysAgo(sinceDaysAgo));
  const groups = new Map<
    string,
    { name: string; count: number; calories: number; protein: number; grams: number; gramsCount: number }
  >();
  for (const day of days) {
    for (const entry of day.entries) {
      const key = entry.name.trim().toLowerCase();
      if (!key) continue;
      const g = groups.get(key) ?? { name: entry.name.trim(), count: 0, calories: 0, protein: 0, grams: 0, gramsCount: 0 };
      g.name = entry.name.trim();
      g.count += 1;
      g.calories += entry.calories;
      g.protein += entry.protein;
      if (entry.grams != null) {
        g.grams += entry.grams;
        g.gramsCount += 1;
      }
      groups.set(key, g);
    }
  }
  return Array.from(groups.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((g) => ({
      name: g.name,
      count: g.count,
      avgCalories: Math.round(g.calories / g.count),
      avgProtein: Math.round((g.protein / g.count) * 10) / 10,
      avgGrams: g.gramsCount > 0 ? Math.round(g.grams / g.gramsCount) : undefined,
    }));
}

export interface FrequentWorkout {
  type: string;
  count: number;
  avgDurationSec: number;
  avgDistanceMeters?: number;
  avgCalories?: number;
}

/** Ranks the user's own logged workouts by type frequency, for a "past workouts" picker — same short window rationale as getFrequentMeals. */
export async function getFrequentWorkouts(uid: string, sinceDaysAgo = 30, limit = 8): Promise<FrequentWorkout[]> {
  const workouts = await getWorkoutsSince(uid, localDateKeyDaysAgo(sinceDaysAgo));
  const groups = new Map<
    string,
    { type: string; count: number; duration: number; distance: number; distanceCount: number; calories: number; caloriesCount: number }
  >();
  for (const w of workouts) {
    const key = w.type.trim().toLowerCase();
    if (!key) continue;
    const g = groups.get(key) ?? { type: w.type.trim(), count: 0, duration: 0, distance: 0, distanceCount: 0, calories: 0, caloriesCount: 0 };
    g.type = w.type.trim();
    g.count += 1;
    g.duration += w.duration;
    if (w.distance != null) {
      g.distance += w.distance;
      g.distanceCount += 1;
    }
    if (w.calories != null) {
      g.calories += w.calories;
      g.caloriesCount += 1;
    }
    groups.set(key, g);
  }
  return Array.from(groups.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((g) => ({
      type: g.type,
      count: g.count,
      avgDurationSec: Math.round(g.duration / g.count),
      avgDistanceMeters: g.distanceCount > 0 ? Math.round(g.distance / g.distanceCount) : undefined,
      avgCalories: g.caloriesCount > 0 ? Math.round(g.calories / g.caloriesCount) : undefined,
    }));
}

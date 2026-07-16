"use client";

/**
 * Client-side Firestore reads for the dashboard. Firestore rules only allow a
 * user to read their own `users/{uid}/**` subtree, so these run with the
 * signed-in user's ID token via the browser SDK (no API route needed).
 */
import {
  collection,
  getDocs,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import type { NutritionEntry, Workout } from "@/lib/types";

export interface DayTotals {
  /** yyyy-mm-dd, local to the browser */
  date: string;
  calories: number;
  protein: number;
  workoutMinutes: number;
  workoutKcal: number;
}

function startOfDayIso(daysAgo: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

/**
 * Local (browser timezone) yyyy-mm-dd for a Date, `daysAgo` days before today.
 * Deliberately NOT `toISOString().slice(0, 10)` — that converts to UTC first,
 * which mislabels "today" as yesterday for any timezone ahead of UTC.
 */
function localDateKeyForDaysAgo(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return localDateKey(d);
}

/** Local (browser timezone) yyyy-mm-dd for an ISO timestamp string. */
function localDateKey(input: string | Date): string {
  const d = typeof input === "string" ? new Date(input) : input;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function getNutritionSince(uid: string, sinceIso: string): Promise<NutritionEntry[]> {
  const col = collection(db, "users", uid, "nutrition");
  const q = query(col, where("loggedAt", ">=", sinceIso), orderBy("loggedAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as NutritionEntry);
}

export async function getWorkoutsSince(uid: string, sinceIso: string): Promise<Workout[]> {
  const col = collection(db, "users", uid, "workouts");
  const q = query(col, where("startedAt", ">=", sinceIso), orderBy("startedAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as Workout);
}

/** Buckets nutrition + workout entries from the last `days` days into per-day totals. */
export function bucketByDay(
  nutrition: NutritionEntry[],
  workouts: Workout[],
  days: number,
): DayTotals[] {
  const buckets = new Map<string, DayTotals>();
  for (let i = days - 1; i >= 0; i--) {
    const date = localDateKeyForDaysAgo(i);
    buckets.set(date, { date, calories: 0, protein: 0, workoutMinutes: 0, workoutKcal: 0 });
  }

  for (const entry of nutrition) {
    const date = localDateKey(entry.loggedAt);
    const bucket = buckets.get(date);
    if (!bucket) continue;
    bucket.calories += entry.calories;
    bucket.protein += entry.protein;
  }

  for (const w of workouts) {
    const date = localDateKey(w.startedAt);
    const bucket = buckets.get(date);
    if (!bucket) continue;
    bucket.workoutMinutes += w.durationSec / 60;
    bucket.workoutKcal += w.activeEnergyKcal ?? 0;
  }

  return Array.from(buckets.values());
}

export { startOfDayIso };

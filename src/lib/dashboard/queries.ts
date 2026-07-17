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
import type { MealDay, Workout } from "@/lib/types";

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

/** All meal days with doc id (= date) >= sinceDate. Doc ids sort lexically, same trick as everywhere else in this file. */
export async function getMealDaysSince(uid: string, sinceDate: string): Promise<MealDay[]> {
  const col = collection(db, "users", uid, "meals");
  const q = query(col, where(documentId(), ">=", sinceDate));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as MealDay);
}

export async function getWorkoutsSince(uid: string, sinceDate: string): Promise<Workout[]> {
  const col = collection(db, "users", uid, "workouts");
  const q = query(col, where("date", ">=", sinceDate));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as Workout);
}

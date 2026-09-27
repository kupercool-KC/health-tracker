"use client";

/**
 * Client-side Firestore reads/writes for custom daily goals — no AI parsing
 * involved (just a checkbox/number + note), so the client writes directly
 * rather than going through an API route, same trust level as the meta docs
 * (see firestore.rules' users/{uid}/dailyGoals/{date} rule).
 */
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import type { DailyGoalEntry, DailyGoals } from "@/lib/types";

export async function getDailyGoals(uid: string, date: string): Promise<DailyGoals> {
  const ref = doc(db, "users", uid, "dailyGoals", date);
  const snap = await getDoc(ref);
  return (snap.data() as DailyGoals | undefined) ?? { date, entries: [] };
}

/** Upserts one goal's entry for a day, leaving the rest of that day's entries untouched. */
export async function setDailyGoalEntry(uid: string, date: string, entry: DailyGoalEntry): Promise<void> {
  const current = await getDailyGoals(uid, date);
  const entries = [...current.entries.filter((e) => e.goalId !== entry.goalId), entry];
  const ref = doc(db, "users", uid, "dailyGoals", date);
  await setDoc(ref, { date, entries });
}

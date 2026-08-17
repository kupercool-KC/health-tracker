"use client";

/**
 * Tracks WHEN calorieGoal/proteinGoal actually changed, so History's charts
 * can show the goal that was really in effect on each past day instead of
 * applying today's current value retroactively across the whole range (the
 * previous behavior — a goal change would silently rewrite what "on target"
 * meant for every past day too).
 *
 * users/{uid}/meta/goalHistory → { entries: GoalHistoryEntry[] }, one entry
 * per day a change was saved (same-day edits collapse into one entry — only
 * the latest value for that day matters for the "goal on this date" lookup
 * below). No backfill: days before the earliest recorded entry fall back to
 * the current value, same as this app's behavior before this feature
 * existed — nothing regresses, it just starts getting more accurate from
 * whenever a user's first goal change is recorded.
 */
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { localDateKey } from "@/lib/dashboard/queries";

export interface GoalHistoryEntry {
  /** yyyy-mm-dd, local — the day this new value took effect. */
  date: string;
  calorieGoal?: number;
  proteinGoal?: number;
}

interface GoalHistoryDoc {
  entries: GoalHistoryEntry[];
}

export async function getGoalHistory(uid: string): Promise<GoalHistoryEntry[]> {
  const ref = doc(db, "users", uid, "meta", "goalHistory");
  const snap = await getDoc(ref);
  return (snap.data() as GoalHistoryDoc | undefined)?.entries ?? [];
}

/**
 * Call right around wherever the profile document's calorieGoal/proteinGoal
 * fields get written (Profile.tsx's quick-edit save, Onboarding.tsx's
 * recalculate-from-formula save) — a no-op when neither actually changed.
 */
export async function recordGoalChange(
  uid: string,
  before: { calorieGoal?: number; proteinGoal?: number },
  after: { calorieGoal?: number; proteinGoal?: number },
): Promise<void> {
  const changedCalories = after.calorieGoal != null && after.calorieGoal !== before.calorieGoal;
  const changedProtein = after.proteinGoal != null && after.proteinGoal !== before.proteinGoal;
  if (!changedCalories && !changedProtein) return;

  const ref = doc(db, "users", uid, "meta", "goalHistory");
  const existing = await getGoalHistory(uid);
  const date = localDateKey();
  const entry: GoalHistoryEntry = {
    date,
    ...(changedCalories ? { calorieGoal: after.calorieGoal } : {}),
    ...(changedProtein ? { proteinGoal: after.proteinGoal } : {}),
  };
  const withoutToday = existing.filter((e) => e.date !== date);
  await setDoc(ref, { entries: [...withoutToday, entry] }, { merge: true });
}

/**
 * Which calorieGoal/proteinGoal was actually in effect on a given day —
 * the latest recorded entry with date <= the queried day, falling back to
 * `currentValue` for any day before the earliest recorded change.
 */
export function goalValueOnDate(
  entries: GoalHistoryEntry[],
  date: string,
  field: "calorieGoal" | "proteinGoal",
  currentValue: number,
): number {
  let value = currentValue;
  let bestDate: string | null = null;
  for (const e of entries) {
    const fieldValue = e[field];
    if (fieldValue == null || e.date > date) continue;
    if (bestDate == null || e.date > bestDate) {
      bestDate = e.date;
      value = fieldValue;
    }
  }
  return value;
}

/**
 * Manually add/replace one entry by date — for backfilling a change that
 * happened before this feature existed (or correcting a wrong auto-recorded
 * one), from Profile's goal-history editor. Unlike recordGoalChange (which
 * only ever touches today's date and requires an actual before/after diff),
 * this takes the date and values as given, no questions asked.
 */
export async function upsertGoalHistoryEntry(uid: string, entry: GoalHistoryEntry): Promise<void> {
  const ref = doc(db, "users", uid, "meta", "goalHistory");
  const existing = await getGoalHistory(uid);
  const withoutDate = existing.filter((e) => e.date !== entry.date);
  await setDoc(ref, { entries: [...withoutDate, entry] }, { merge: true });
}

/** Remove the entry for one date — from Profile's goal-history editor. */
export async function deleteGoalHistoryEntry(uid: string, date: string): Promise<void> {
  const ref = doc(db, "users", uid, "meta", "goalHistory");
  const existing = await getGoalHistory(uid);
  await setDoc(ref, { entries: existing.filter((e) => e.date !== date) }, { merge: true });
}

/** Distinct dates (within `sinceDate..untilDate`, inclusive) where `field` actually changed — used to annotate a chart with "goal changed" markers. */
export function goalChangeDatesInRange(
  entries: GoalHistoryEntry[],
  field: "calorieGoal" | "proteinGoal",
  sinceDate: string,
  untilDate: string,
): GoalHistoryEntry[] {
  return entries
    .filter((e) => e[field] != null && e.date >= sinceDate && e.date <= untilDate)
    .sort((a, b) => a.date.localeCompare(b.date));
}

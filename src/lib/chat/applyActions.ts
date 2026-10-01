/**
 * Executes confirmed PendingActions. Server-side so the WhatsApp webhook
 * (no browser session) and the web Confirm button (/api/chat/apply-actions)
 * share one implementation. Each action re-validates that its target still
 * exists, and profile changes go through a whitelist — the model proposes
 * them, but this is the layer that decides what is actually writable.
 */
import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import type { PendingAction, UserProfile } from "@/lib/types";

export const PROFILE_WRITABLE_KEYS = [
  "name",
  "age",
  "gender",
  "height",
  "weight",
  "goals",
  "activityLevel",
  "workoutTypes",
  "dietaryPrefs",
  "avoidFoods",
  "allergies",
  "preferredFoods",
  "calorieGoal",
  "proteinGoal",
  "carbGoal",
  "fatGoal",
  "stepGoal",
  "averageDailySteps",
  "netCalorieBurnFactor",
  "customGoals",
  "showCarbs",
  "showFat",
  "showFiber",
  "language",
  "units",
] as const satisfies readonly (keyof UserProfile)[];

export function pickWritableProfile(changes: Record<string, unknown>): Partial<UserProfile> {
  const out: Record<string, unknown> = {};
  for (const k of PROFILE_WRITABLE_KEYS) if (k in changes && changes[k] !== undefined) out[k] = changes[k];
  return out as Partial<UserProfile>;
}

export async function applyPendingActions(uid: string, actions: PendingAction[]): Promise<{ applied: number; failed: string[] }> {
  const u = adminDb.collection("users").doc(uid);
  let applied = 0;
  const failed: string[] = [];
  for (const a of actions) {
    try {
      if (a.type === "workout_delete") {
        const ref = u.collection("workouts").doc(a.id);
        if (!(await ref.get()).exists) throw new Error("not found");
        await ref.delete();
      } else if (a.type === "workout_update") {
        const ref = u.collection("workouts").doc(a.id);
        if (!(await ref.get()).exists) throw new Error("not found");
        await ref.update(a.changes);
      } else if (a.type === "steps_delete") {
        const ref = u.collection("steps").doc(a.date);
        if (!(await ref.get()).exists) throw new Error("not found");
        await ref.delete();
      } else if (a.type === "body_metrics_delete") {
        const ref = u.collection("bodyMetrics").doc(a.date);
        if (!(await ref.get()).exists) throw new Error("not found");
        await ref.delete();
      } else if (a.type === "profile_update") {
        const changes = pickWritableProfile(a.changes as Record<string, unknown>);
        if (Object.keys(changes).length === 0) throw new Error("nothing writable");
        await u.collection("meta").doc("profile").set({ ...changes, updatedAt: new Date().toISOString() }, { merge: true });
      }
      applied++;
    } catch {
      failed.push(a.label);
    }
  }
  return { applied, failed };
}

/**
 * Saves an already-parsed pendingX proposal from a ChatMessage — the same
 * write each of /api/nutrition, /api/workouts, /api/steps, /api/body-metrics
 * does for their own "parsed" confirm-flow payload, factored out here so the
 * WhatsApp webhook (which confirms via a text reply instead of a UI button,
 * and has no browser session to call those routes with) can save directly
 * server-side without re-implementing or re-parsing anything.
 */
import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import type { BodyMetricsEntry, ChatMessage, DailySteps, MealDay, MealEntry, Workout } from "@/lib/types";

function recomputeMealTotals(entries: MealEntry[]): MealDay["totals"] {
  return entries.reduce(
    (acc, e) => ({
      calories: acc.calories + e.calories,
      protein: acc.protein + e.protein,
      carbs: acc.carbs + (e.carbs ?? 0),
      fat: acc.fat + (e.fat ?? 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
}

/** Same edit/delete the web chat's Confirm button does via PATCH/DELETE /api/nutrition. Returns false if the entry no longer exists. */
export async function applyMealActionFromPending(
  uid: string,
  pending: NonNullable<ChatMessage["pendingMealAction"]>,
): Promise<boolean> {
  const ref = adminDb.collection("users").doc(uid).collection("meals").doc(pending.date);
  let found = false;
  await adminDb.runTransaction(async (tx) => {
    const existing = (await tx.get(ref)).data() as MealDay | undefined;
    const before = existing?.entries ?? [];
    found = before.some((e) => e.id === pending.entryId);
    if (!found) return;
    const entries =
      pending.action === "delete"
        ? before.filter((e) => e.id !== pending.entryId)
        : before.map((e) => (e.id === pending.entryId ? { ...e, ...pending.changes } : e));
    tx.set(ref, { date: pending.date, entries, totals: recomputeMealTotals(entries) });
  });
  return found;
}

export async function saveMealFromPending(uid: string, pending: NonNullable<ChatMessage["pendingMeal"]>): Promise<void> {
  const { imageUrls, date, items } = pending;
  const now = new Date().toISOString();
  const dateStr = date ?? now.slice(0, 10);

  const newEntries: MealEntry[] = items.map((item) => ({
    id: crypto.randomUUID(),
    time: now,
    name: item.description,
    calories: item.calories,
    protein: item.protein,
    carbs: item.carbs,
    fat: item.fat,
    fiber: item.fiber,
    sugar: item.sugar,
    saturatedFat: item.saturatedFat,
    sodium: item.sodium,
    nutrientsEstimated: item.nutrientsEstimated,
    grams: item.grams,
    ingredients: item.ingredients,
    source: imageUrls?.length ? "photo" : "text",
    confidence: item.confidence,
    confirmedAt: now,
    nutritionSource: item.nutritionSource,
    nutritionNote: item.nutritionNote,
  }));

  const ref = adminDb.collection("users").doc(uid).collection("meals").doc(dateStr);
  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.data() as MealDay | undefined;
    const entries = [...(existing?.entries ?? []), ...newEntries];
    tx.set(ref, { date: dateStr, entries, totals: recomputeMealTotals(entries) });
  });
}

export async function saveWorkoutFromPending(uid: string, pending: NonNullable<ChatMessage["pendingWorkout"]>): Promise<void> {
  const { date, ...parsed } = pending;
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const workout: Workout = {
    id,
    userId: uid,
    type: parsed.type,
    date,
    startTime: now,
    endTime: new Date(Date.parse(now) + parsed.durationSec * 1000).toISOString(),
    duration: parsed.durationSec,
    distance: parsed.distanceMeters,
    pace: parsed.paceSecPerKm,
    calories: parsed.calories,
    heartRate:
      parsed.heartRateAvg != null || parsed.heartRateMax != null
        ? { avg: parsed.heartRateAvg, max: parsed.heartRateMax }
        : undefined,
    elevationGain: parsed.elevationGainMeters,
    source: "manual",
    externalId: id,
    syncedAt: now,
  };

  await adminDb.collection("users").doc(uid).collection("workouts").doc(id).set(workout);
}

export async function saveStepsFromPending(uid: string, pending: NonNullable<ChatMessage["pendingSteps"]>): Promise<void> {
  const doc: DailySteps = { date: pending.date, steps: pending.steps, source: "manual", syncedAt: new Date().toISOString() };
  await adminDb.collection("users").doc(uid).collection("steps").doc(pending.date).set(doc);
}

export async function saveBodyMetricsFromPending(
  uid: string,
  pending: NonNullable<ChatMessage["pendingBodyMetrics"]>,
): Promise<void> {
  const { date, imageUrls: _imageUrls, ...parsed } = pending;
  const entry: BodyMetricsEntry = { date, confirmedAt: new Date().toISOString(), ...parsed };
  await adminDb.collection("users").doc(uid).collection("bodyMetrics").doc(date).set(entry);
}

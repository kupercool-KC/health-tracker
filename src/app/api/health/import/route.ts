/**
 * POST /api/health/import
 * Auth: Firebase ID token (Bearer). Called by the iOS app after reading HealthKit on the device.
 *
 * Body: { workouts, steps, sleep, restingHr, body, heightCm?, spanDays, autoFill? }
 *  - workouts upsert into users/{uid}/workouts/{externalId}; a manual/chat workout that is the same session
 *    (same day, category and similar duration) is merged into the Health record (Health wins, notes kept).
 *  - steps → steps/{date} (Health is authoritative), sleep → sleep/{date}, restingHr → vitals/{date},
 *    bodyFat/weight → bodyMetrics/{date} (merge, never overwrites a richer smart-scale entry).
 *  - Returns profile suggestions derived from the data. With autoFill=true the profile is updated with them
 *    (weekly auto-update); otherwise they are only returned (onboarding shows them for confirmation).
 * Read-only data: nothing is ever written back to Health.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getUidFromRequest } from "@/lib/auth";
import { adminDb } from "@/lib/firebase/admin";
import { buildSuggestions } from "@/lib/health/suggestions";
import { categoryOfHk, categoryOfName, displayNameOfHk, isSameSession } from "@/lib/health/workoutMap";
import type { HealthSyncMeta, Workout } from "@/lib/types";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const bodySchema = z.object({
  workouts: z
    .array(
      z.object({
        externalId: z.string().min(1),
        hkType: z.string().min(1),
        startTime: z.string(),
        endTime: z.string(),
        durationSec: z.number().nonnegative(),
        date,
        calories: z.number().nonnegative().optional(),
        distanceM: z.number().nonnegative().optional(),
        device: z.string().optional(),
      }),
    )
    .max(1000),
  steps: z.array(z.object({ date, steps: z.number().nonnegative() })).max(400),
  sleep: z.array(z.object({ date, asleepMin: z.number().nonnegative(), inBedMin: z.number().nonnegative().optional() })).max(400),
  restingHr: z.array(z.object({ date, bpm: z.number().positive() })).max(400),
  body: z.array(z.object({ date, weightKg: z.number().positive().optional(), bodyFatPercent: z.number().nonnegative().optional() })).max(400),
  heightCm: z.number().positive().optional(),
  spanDays: z.number().positive().max(400),
  autoFill: z.boolean().optional(),
});

export async function POST(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;
  const user = adminDb.collection("users").doc(uid);
  const now = new Date().toISOString();

  // --- workouts (with merge of duplicate manual entries) ---
  const manualByDate = new Map<string, Workout[]>();
  const dates = [...new Set(d.workouts.map((w) => w.date))];
  for (let i = 0; i < dates.length; i += 30) {
    const snap = await user.collection("workouts").where("date", "in", dates.slice(i, i + 30)).get();
    for (const doc of snap.docs) {
      const w = doc.data() as Workout;
      if (w.source !== "manual") continue;
      manualByDate.set(w.date, [...(manualByDate.get(w.date) ?? []), w]);
    }
  }
  let merged = 0;
  const workoutsCol = user.collection("workouts");
  for (let i = 0; i < d.workouts.length; i += 400) {
    const batch = adminDb.batch();
    for (const w of d.workouts.slice(i, i + 400)) {
      const category = categoryOfHk(w.hkType);
      const dup = (manualByDate.get(w.date) ?? []).find((m) =>
        isSameSession({ category: categoryOfName(m.type), durationSec: m.duration, date: m.date }, { category, durationSec: w.durationSec, date: w.date }),
      );
      if (dup) {
        batch.delete(workoutsCol.doc(dup.externalId));
        manualByDate.set(w.date, (manualByDate.get(w.date) ?? []).filter((m) => m !== dup));
        merged++;
      }
      const workout: Workout = {
        id: w.externalId,
        userId: uid,
        type: displayNameOfHk(w.hkType),
        hkType: w.hkType,
        category,
        device: w.device,
        date: w.date,
        startTime: w.startTime,
        endTime: w.endTime,
        duration: w.durationSec,
        distance: w.distanceM,
        calories: w.calories != null ? Math.round(w.calories) : undefined,
        source: "appleHealth",
        externalId: w.externalId,
        syncedAt: now,
      };
      batch.set(workoutsCol.doc(w.externalId), workout, { merge: true });
    }
    await batch.commit();
  }

  // --- steps / sleep / resting HR / body ---
  const writes: { ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown>; merge: boolean }[] = [];
  for (const s of d.steps) writes.push({ ref: user.collection("steps").doc(s.date), data: { date: s.date, steps: Math.round(s.steps), source: "appleHealth", syncedAt: now }, merge: false });
  for (const s of d.sleep) writes.push({ ref: user.collection("sleep").doc(s.date), data: { date: s.date, asleepMin: Math.round(s.asleepMin), inBedMin: s.inBedMin != null ? Math.round(s.inBedMin) : undefined, syncedAt: now }, merge: false });
  for (const h of d.restingHr) writes.push({ ref: user.collection("vitals").doc(h.date), data: { date: h.date, restingHr: Math.round(h.bpm), syncedAt: now }, merge: true });
  for (const b of d.body) {
    const data: Record<string, unknown> = { date: b.date, syncedAt: now };
    if (b.weightKg != null) data.weightKg = Math.round(b.weightKg * 10) / 10;
    if (b.bodyFatPercent != null) data.bodyFatPercent = Math.round(b.bodyFatPercent * 10) / 10;
    writes.push({ ref: user.collection("bodyMetrics").doc(b.date), data, merge: true });
  }
  for (let i = 0; i < writes.length; i += 400) {
    const batch = adminDb.batch();
    for (const w of writes.slice(i, i + 400)) batch.set(w.ref, w.data, { merge: w.merge });
    await batch.commit();
  }

  // --- suggestions + optional auto-fill ---
  const latest = <T extends { date: string }>(rows: T[]) => [...rows].sort((a, b) => b.date.localeCompare(a.date))[0];
  const suggestions = buildSuggestions({
    workouts: d.workouts.map((w) => ({ hkType: w.hkType, startTime: w.startTime, durationSec: w.durationSec })),
    stepsByDay: d.steps.map((s) => s.steps),
    sleepAsleepMin: d.sleep.map((s) => s.asleepMin),
    restingHrByDay: d.restingHr.map((h) => h.bpm),
    latestWeightKg: latest(d.body.filter((b) => b.weightKg != null))?.weightKg,
    latestBodyFat: latest(d.body.filter((b) => b.bodyFatPercent != null))?.bodyFatPercent,
    heightCm: d.heightCm,
    spanDays: d.spanDays,
  });

  const meta: HealthSyncMeta = { lastSyncAt: now, workouts: d.workouts.length, sleepNights: d.sleep.length, stepDays: d.steps.length };
  if (d.autoFill) {
    const patch: Record<string, unknown> = { updatedAt: now };
    if (suggestions.weightKg) patch.weight = Math.round(suggestions.weightKg);
    if (suggestions.heightCm) patch.height = Math.round(suggestions.heightCm);
    if (suggestions.averageDailySteps) patch.averageDailySteps = suggestions.averageDailySteps;
    if (suggestions.workoutTypes.length) patch.workoutTypes = suggestions.workoutTypes;
    if (suggestions.activityLevel) patch.activityLevel = suggestions.activityLevel;
    await user.collection("meta").doc("profile").set(patch, { merge: true });
    meta.autoFilledAt = now;
  }
  await user.collection("meta").doc("healthSync").set(meta, { merge: true });

  return NextResponse.json({ ok: true, merged, suggestions });
}

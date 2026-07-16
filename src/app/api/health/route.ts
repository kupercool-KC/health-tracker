/**
 * POST /api/health
 * Ingest endpoint for Apple Health workouts pushed from an iOS Shortcut.
 * Auth: shared secret via `Authorization: Bearer <HEALTH_INGEST_TOKEN>`.
 *
 * The Shortcut must include the target userId in the body (the device knows
 * whose data it is; there's no interactive login on that side).
 *
 * Body: { userId: string, workouts: Workout[] }
 * Workouts are deduped on externalId (HKWorkout UUID) so re-runs are safe.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { isValidHealthToken } from "@/lib/auth";
import { adminDb } from "@/lib/firebase/admin";
import type { Workout } from "@/lib/types";

const workoutSchema = z.object({
  activityType: z.string(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  durationSec: z.number().nonnegative(),
  activeEnergyKcal: z.number().nonnegative().optional(),
  distanceMeters: z.number().nonnegative().optional(),
  averageHeartRate: z.number().positive().optional(),
  externalId: z.string().min(1),
});

const bodySchema = z.object({
  userId: z.string().min(1),
  workouts: z.array(workoutSchema).min(1),
});

export async function POST(req: Request) {
  if (!isValidHealthToken(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { userId, workouts } = parsed.data;
  const now = new Date().toISOString();
  const col = adminDb.collection("users").doc(userId).collection("workouts");

  // Dedupe on externalId: use it as the doc id so repeated pushes upsert.
  const batch = adminDb.batch();
  for (const w of workouts) {
    const ref = col.doc(w.externalId);
    const doc: Workout = { id: w.externalId, userId, createdAt: now, ...w };
    batch.set(ref, doc, { merge: true });
  }
  await batch.commit();

  return NextResponse.json({ ingested: workouts.length }, { status: 200 });
}

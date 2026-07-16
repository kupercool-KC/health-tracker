/**
 * POST /api/health
 * Ingest endpoint for Apple Health workouts pushed from an iOS Shortcut.
 * Auth: personal Health Sync token via `Authorization: Bearer <token>`,
 * minted per-user from /api/settings/health-token. The token itself
 * identifies the owning user — the Shortcut no longer needs to send a
 * userId, so a stolen/misconfigured token can't be pointed at someone else's
 * account.
 *
 * Body: { workouts: Workout[] }
 * Workouts are deduped on externalId (HKWorkout UUID) so re-runs are safe.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveUidFromHealthToken } from "@/lib/healthToken";
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
  workouts: z.array(workoutSchema).min(1),
});

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const userId = token ? await resolveUidFromHealthToken(token) : null;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { workouts } = parsed.data;
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

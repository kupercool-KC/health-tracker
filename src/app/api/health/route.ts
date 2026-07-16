/**
 * POST /api/health
 * Ingest endpoint for Apple Health workouts.
 * Auth: personal Health Sync token via `Authorization: Bearer <token>`,
 * minted per-user from /api/settings/health-token. The token itself
 * identifies the owning user — callers never send a userId, so a
 * stolen/misconfigured token can't be pointed at someone else's account.
 *
 * Body: { workouts: Workout[] } — this is a simplified flat shape. The real
 * Health Auto Export payload nests quantities as {qty, units} inside a
 * {data: {workouts: [...]}} envelope with non-standard date strings; that
 * adapter (unit conversion, envelope unwrapping) is separate follow-up work.
 * This route just needs to compile against the current Workout type for now.
 *
 * Workouts are deduped on externalId so re-runs upsert instead of duplicating.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveUidFromHealthToken } from "@/lib/healthToken";
import { adminDb } from "@/lib/firebase/admin";
import type { Workout } from "@/lib/types";

const workoutSchema = z.object({
  type: z.string(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  duration: z.number().nonnegative(),
  calories: z.number().nonnegative().optional(),
  distance: z.number().nonnegative().optional(),
  pace: z.number().nonnegative().optional(),
  heartRate: z.object({ avg: z.number().positive().optional(), max: z.number().positive().optional() }).optional(),
  elevationGain: z.number().optional(),
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
    const workout: Workout = {
      id: w.externalId,
      userId,
      date: w.startTime.slice(0, 10),
      source: "appleHealth",
      syncedAt: now,
      ...w,
    };
    batch.set(ref, workout, { merge: true });
  }
  await batch.commit();

  return NextResponse.json({ ingested: workouts.length }, { status: 200 });
}

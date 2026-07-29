/**
 * POST /api/workouts
 * Body: { text?: string, imageUrl?: string, date?: string, parsed?: ParsedWorkout }
 * Auth: Firebase ID token (Bearer).
 *
 * Manual workout logging — separate from POST /api/health, which is the
 * token-authenticated Apple Health / Health Auto Export ingest webhook.
 * This route is for a user typing "ran 5k in 28 minutes" or uploading a
 * screenshot of a workout summary from any app, parsed via
 * src/lib/workout/parser.ts (mirrors /api/nutrition's shape — accepts an
 * already-parsed `parsed` payload too, for a future chat-based confirm flow).
 *
 * `date` (yyyy-mm-dd) should be the client's *local* date — same rationale
 * as /api/nutrition: the server has no timezone context.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getUidFromRequest } from "@/lib/auth";
import { parseWorkout } from "@/lib/workout/parser";
import { adminDb } from "@/lib/firebase/admin";
import type { ParsedWorkout, Workout } from "@/lib/types";

const parsedWorkoutSchema = z.object({
  type: z.string().min(1),
  durationSec: z.number().nonnegative(),
  distanceMeters: z.number().nonnegative().optional(),
  paceSecPerKm: z.number().nonnegative().optional(),
  calories: z.number().nonnegative().optional(),
  heartRateAvg: z.number().positive().optional(),
  heartRateMax: z.number().positive().optional(),
  elevationGainMeters: z.number().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const bodySchema = z
  .object({
    text: z.string().optional(),
    // Firebase Storage download URL uploaded client-side (see uploadWorkoutImage).
    imageUrl: z.string().url().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    parsed: parsedWorkoutSchema.optional(),
  })
  .refine((b) => b.text || b.imageUrl || b.parsed, {
    message: "Provide text, imageUrl, or parsed",
  });

export async function POST(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsedBody = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsedBody.error.flatten() },
      { status: 400 },
    );
  }

  const { text, imageUrl, date } = parsedBody.data;

  let parsed: ParsedWorkout;
  try {
    parsed = parsedBody.data.parsed ?? (await parseWorkout({ text, imageUrl }));
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to parse workout", detail: String(err) },
      { status: 502 },
    );
  }

  const now = new Date().toISOString();
  const dateStr = date ?? now.slice(0, 10);
  const id = crypto.randomUUID();

  const workout: Workout = {
    id,
    userId: uid,
    type: parsed.type,
    date: dateStr,
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

  // Firestore rejects `undefined` field values — strip them before writing
  // rather than special-casing every optional field (see /api/chat's fix for
  // the same class of bug).
  const clean = JSON.parse(JSON.stringify(workout)) as Workout;

  await adminDb.collection("users").doc(uid).collection("workouts").doc(id).set(clean);

  return NextResponse.json(clean, { status: 201 });
}

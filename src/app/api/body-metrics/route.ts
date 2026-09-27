/**
 * POST /api/body-metrics
 * Body: { imageUrls?: string[], text?: string, date?: string, parsed?: ParsedBodyMetrics }
 *
 * DELETE /api/body-metrics
 * Body: { date: string }
 *
 * Auth: Firebase ID token (Bearer) on both.
 *
 * Weekly weigh-in logging — screenshot(s) of a smart scale's app, parsed via
 * src/lib/bodyMetrics/parser.ts (mirrors /api/workouts' shape: accepts an
 * already-parsed `parsed` payload too, for the chat confirm flow, so a
 * confirmed reading isn't re-parsed).
 *
 * One doc per day (users/{uid}/bodyMetrics/{date}) — a second weigh-in
 * logged the same day overwrites the first rather than creating a second
 * entry, same "last write wins" posture as steps.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthFromRequest, getUidFromRequest } from "@/lib/auth";
import { parseBodyMetrics } from "@/lib/bodyMetrics/parser";
import { adminDb } from "@/lib/firebase/admin";
import type { BodyMetricsEntry, ParsedBodyMetrics } from "@/lib/types";

const parsedBodyMetricsSchema = z.object({
  weightKg: z.number().positive().optional(),
  bmi: z.number().positive().optional(),
  muscleMassKg: z.number().positive().optional(),
  bodyFatPercent: z.number().nonnegative().optional(),
  visceralFat: z.number().nonnegative().optional(),
  bodyWaterPercent: z.number().nonnegative().optional(),
  basalMetabolicRate: z.number().positive().optional(),
  proteinPercent: z.number().nonnegative().optional(),
});

const postBodySchema = z
  .object({
    text: z.string().optional(),
    imageUrls: z.array(z.string().url()).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    parsed: parsedBodyMetricsSchema.optional(),
  })
  .refine((b) => b.text || b.imageUrls?.length || b.parsed, {
    message: "Provide text, imageUrls, or parsed",
  });

export async function POST(req: Request) {
  const auth = await getAuthFromRequest(req);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { uid } = auth;

  const parsedBody = postBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsedBody.error.flatten() },
      { status: 400 },
    );
  }

  const { text, imageUrls, date } = parsedBody.data;

  let parsed: ParsedBodyMetrics;
  try {
    parsed = parsedBody.data.parsed ?? (await parseBodyMetrics({ text, imageUrls }));
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to parse weigh-in", detail: String(err) },
      { status: 502 },
    );
  }

  if (Object.keys(parsed).length === 0) {
    return NextResponse.json(
      { error: "Couldn't read any metrics from that — try a clearer screenshot" },
      { status: 422 },
    );
  }

  const now = new Date().toISOString();
  const dateStr = date ?? now.slice(0, 10);

  const entry: BodyMetricsEntry = { date: dateStr, confirmedAt: now, ...parsed };
  // Firestore rejects `undefined` field values — strip them before writing.
  const clean = JSON.parse(JSON.stringify(entry)) as BodyMetricsEntry;

  await adminDb.collection("users").doc(uid).collection("bodyMetrics").doc(dateStr).set(clean);

  return NextResponse.json(clean, { status: 201 });
}

const deleteBodySchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

export async function DELETE(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsedBody = deleteBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsedBody.error.flatten() },
      { status: 400 },
    );
  }

  const ref = adminDb.collection("users").doc(uid).collection("bodyMetrics").doc(parsedBody.data.date);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Entry not found" }, { status: 404 });
  }
  await ref.delete();
  return NextResponse.json({ ok: true });
}

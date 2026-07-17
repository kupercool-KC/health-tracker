/**
 * POST /api/nutrition
 * Body: { text?: string, imageUrl?: string, loggedAt?: string, date?: string, parsed?: ParsedNutrition }
 * Auth: Firebase ID token (Bearer).
 *
 * Appends a MealEntry into the day's users/{uid}/meals/{date} doc (creating
 * it if needed), and returns the entry. If `parsed` is provided (the chat
 * confirm flow already has a ParsedNutrition from /api/chat's log_meal
 * intent), it's used as-is instead of calling parseNutrition() again —
 * avoids a second, possibly-inconsistent OpenAI call for input already
 * parsed once.
 *
 * `date` (yyyy-mm-dd) should be the client's *local* date — the server has no
 * timezone context, and deriving "today" from a UTC timestamp mislabels the
 * day near midnight for any non-UTC timezone (see src/lib/dashboard/queries.ts
 * for the same lesson learned on the read side).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getUidFromRequest } from "@/lib/auth";
import { parseNutrition } from "@/lib/nutrition/parser";
import { adminDb } from "@/lib/firebase/admin";
import type { MealDay, MealEntry, ParsedNutrition } from "@/lib/types";

const parsedNutritionSchema = z.object({
  description: z.string().min(1),
  calories: z.number().nonnegative(),
  protein: z.number().nonnegative(),
  carbs: z.number().nonnegative().optional(),
  fat: z.number().nonnegative().optional(),
  fiber: z.number().nonnegative().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const bodySchema = z
  .object({
    text: z.string().optional(),
    // Firebase Storage download URL uploaded client-side (see uploadNutritionImage).
    imageUrl: z.string().url().optional(),
    loggedAt: z.string().datetime().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    parsed: parsedNutritionSchema.optional(),
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

  const { text, imageUrl, loggedAt, date } = parsedBody.data;

  let parsed: ParsedNutrition;
  try {
    parsed = parsedBody.data.parsed ?? (await parseNutrition({ text, imageUrl }));
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to parse nutrition", detail: String(err) },
      { status: 502 },
    );
  }

  const now = new Date().toISOString();
  const dateStr = date ?? now.slice(0, 10);

  const entry: MealEntry = {
    id: crypto.randomUUID(),
    time: loggedAt ?? now,
    name: parsed.description,
    calories: parsed.calories,
    protein: parsed.protein,
    carbs: parsed.carbs,
    fat: parsed.fat,
    fiber: parsed.fiber,
    source: imageUrl ? "photo" : "text",
    confidence: parsed.confidence,
    confirmedAt: now,
  };

  const ref = adminDb.collection("users").doc(uid).collection("meals").doc(dateStr);
  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.data() as MealDay | undefined;
    const entries = [...(existing?.entries ?? []), entry];
    const totals = entries.reduce(
      (acc, e) => ({
        calories: acc.calories + e.calories,
        protein: acc.protein + e.protein,
        carbs: acc.carbs + (e.carbs ?? 0),
        fat: acc.fat + (e.fat ?? 0),
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0 },
    );
    const day: MealDay = { date: dateStr, entries, totals };
    tx.set(ref, day);
  });

  return NextResponse.json(entry, { status: 201 });
}

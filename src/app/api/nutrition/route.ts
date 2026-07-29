/**
 * POST /api/nutrition
 * Body: { text?: string, imageUrl?: string, loggedAt?: string, date?: string, parsed?: ParsedNutrition }
 *
 * DELETE /api/nutrition
 * Body: { date: string, entryId: string }
 *
 * PATCH /api/nutrition
 * Body: { date: string, entryId: string, changes: Partial<MealEntry> }
 *
 * Auth: Firebase ID token (Bearer) on all three.
 *
 * POST appends one MealEntry per parsed item into the day's
 * users/{uid}/meals/{date} doc (creating it if needed) — a single message
 * can describe several distinct foods (see src/lib/nutrition/parser.ts), so
 * `parsed.items` may contain more than one entry. If `parsed` is provided
 * (the chat confirm flow already has a ParsedNutrition from /api/chat's
 * log_meal intent), it's used as-is instead of calling parseNutrition()
 * again — avoids a second, possibly-inconsistent OpenAI call for input
 * already parsed once.
 *
 * DELETE/PATCH remove or edit a single already-logged entry — used by the
 * Today screen's per-row delete button and by the chat "manage_meal" intent
 * confirm flow (src/lib/chat/chat.ts).
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

const itemSchema = z.object({
  description: z.string().min(1),
  calories: z.number().nonnegative(),
  protein: z.number().nonnegative(),
  carbs: z.number().nonnegative().optional(),
  fat: z.number().nonnegative().optional(),
  fiber: z.number().nonnegative().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const parsedNutritionSchema = z.object({ items: z.array(itemSchema).min(1) });

const postBodySchema = z
  .object({
    text: z.string().optional(),
    // Firebase Storage download URL uploaded client-side (see uploadNutritionImage).
    imageUrl: z.string().url().optional(),
    loggedAt: z.string().datetime().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    parsed: parsedNutritionSchema.optional(),
    lang: z.enum(["en", "he"]).optional(),
  })
  .refine((b) => b.text || b.imageUrl || b.parsed, {
    message: "Provide text, imageUrl, or parsed",
  });

function recomputeTotals(entries: MealEntry[]): MealDay["totals"] {
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

export async function POST(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsedBody = postBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsedBody.error.flatten() },
      { status: 400 },
    );
  }

  const { text, imageUrl, loggedAt, date, lang } = parsedBody.data;

  let parsed: ParsedNutrition;
  try {
    parsed = parsedBody.data.parsed ?? (await parseNutrition({ text, imageUrl, lang }));
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to parse nutrition", detail: String(err) },
      { status: 502 },
    );
  }

  const now = new Date().toISOString();
  const dateStr = date ?? now.slice(0, 10);

  const newEntries: MealEntry[] = parsed.items.map((item) => ({
    id: crypto.randomUUID(),
    time: loggedAt ?? now,
    name: item.description,
    calories: item.calories,
    protein: item.protein,
    carbs: item.carbs,
    fat: item.fat,
    fiber: item.fiber,
    source: imageUrl ? "photo" : "text",
    confidence: item.confidence,
    confirmedAt: now,
  }));

  const ref = adminDb.collection("users").doc(uid).collection("meals").doc(dateStr);
  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.data() as MealDay | undefined;
    const entries = [...(existing?.entries ?? []), ...newEntries];
    const day: MealDay = { date: dateStr, entries, totals: recomputeTotals(entries) };
    tx.set(ref, day);
  });

  return NextResponse.json({ entries: newEntries }, { status: 201 });
}

const deleteBodySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  entryId: z.string().min(1),
});

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
  const { date, entryId } = parsedBody.data;

  const ref = adminDb.collection("users").doc(uid).collection("meals").doc(date);
  let found = false;
  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.data() as MealDay | undefined;
    const before = existing?.entries ?? [];
    const entries = before.filter((e) => e.id !== entryId);
    found = entries.length !== before.length;
    if (found) {
      tx.set(ref, { date, entries, totals: recomputeTotals(entries) });
    }
  });

  if (!found) {
    return NextResponse.json({ error: "Entry not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

const patchBodySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  entryId: z.string().min(1),
  changes: z
    .object({
      name: z.string().min(1).optional(),
      calories: z.number().nonnegative().optional(),
      protein: z.number().nonnegative().optional(),
      carbs: z.number().nonnegative().optional(),
      fat: z.number().nonnegative().optional(),
      fiber: z.number().nonnegative().optional(),
    })
    .refine((c) => Object.keys(c).length > 0, { message: "Provide at least one change" }),
});

export async function PATCH(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsedBody = patchBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsedBody.error.flatten() },
      { status: 400 },
    );
  }
  const { date, entryId, changes } = parsedBody.data;

  const ref = adminDb.collection("users").doc(uid).collection("meals").doc(date);
  let found = false;
  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.data() as MealDay | undefined;
    const entries = (existing?.entries ?? []).map((e) => {
      if (e.id !== entryId) return e;
      found = true;
      return { ...e, ...changes };
    });
    if (found) {
      tx.set(ref, { date, entries, totals: recomputeTotals(entries) });
    }
  });

  if (!found) {
    return NextResponse.json({ error: "Entry not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

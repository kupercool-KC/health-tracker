/**
 * POST /api/nutrition
 * Body: { text?: string, imageUrl?: string, loggedAt?: string }
 * Auth: Firebase ID token (Bearer).
 *
 * Parses the input into { calories, protein }, stores a NutritionEntry under
 * the authenticated user, and returns it.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getUidFromRequest } from "@/lib/auth";
import { parseNutrition } from "@/lib/nutrition/parser";
import { adminDb } from "@/lib/firebase/admin";
import type { NutritionEntry } from "@/lib/types";

const bodySchema = z
  .object({
    text: z.string().optional(),
    // Firebase Storage download URL uploaded client-side (see uploadNutritionImage).
    imageUrl: z.string().url().optional(),
    loggedAt: z.string().datetime().optional(),
  })
  .refine((b) => b.text || b.imageUrl, {
    message: "Provide text or imageUrl",
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

  const { text, imageUrl, loggedAt } = parsedBody.data;

  let parsed;
  try {
    parsed = await parseNutrition({ text, imageUrl });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to parse nutrition", detail: String(err) },
      { status: 502 },
    );
  }

  const now = new Date().toISOString();
  const doc = adminDb.collection("users").doc(uid).collection("nutrition").doc();
  const entry: NutritionEntry = {
    id: doc.id,
    userId: uid,
    description: parsed.description,
    calories: parsed.calories,
    protein: parsed.protein,
    source: imageUrl ? "image" : "chat",
    confidence: parsed.confidence,
    loggedAt: loggedAt ?? now,
    createdAt: now,
  };
  await doc.set(entry);

  return NextResponse.json(entry, { status: 201 });
}

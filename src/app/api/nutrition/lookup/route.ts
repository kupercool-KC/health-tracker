/**
 * POST /api/nutrition/lookup
 * Body: { query: string, quantity?: string }
 *
 * Exposes src/lib/nutrition/usda.ts (server-only) to the client so the
 * frequent-meal picker can fill in grams/calories/protein from whichever one
 * the user typed, instead of requiring the historical average to already
 * have all three. Best-effort: returns { match: null } rather than an error
 * when USDA has nothing usable, so the caller can fall back to manual entry.
 *
 * An optional "quantity" ("1 date", "2 slices") also estimates that
 * quantity's weight in grams — for when the user knows how much they ate in
 * everyday units but not the gram weight; returned as "estimatedGrams".
 *
 * Auth: Firebase ID token (Bearer) — same requirement as every other write
 * path here, even though this one only reads, to avoid an unauthenticated
 * proxy to an external API.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getUidFromRequest } from "@/lib/auth";
import { estimateGramsForQuantity, lookupUsdaNutrients } from "@/lib/nutrition/usda";

const bodySchema = z.object({ query: z.string().min(1), quantity: z.string().min(1).optional() });

export async function POST(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const [match, estimatedGrams] = await Promise.all([
    lookupUsdaNutrients(parsed.data.query),
    parsed.data.quantity ? estimateGramsForQuantity(parsed.data.query, parsed.data.quantity) : Promise.resolve(null),
  ]);
  return NextResponse.json({ match, estimatedGrams });
}

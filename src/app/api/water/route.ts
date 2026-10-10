/**
 * POST /api/water — body { ml: number, date?: yyyy-mm-dd } adds water; { undo: true, date? } removes the last entry.
 * Auth: Firebase ID token (Bearer). Returns the day's new total.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getUidFromRequest } from "@/lib/auth";
import { addWater, undoLastWater } from "@/lib/water/server";

const bodySchema = z.object({
  ml: z.number().positive().max(5000).optional(),
  undo: z.boolean().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function POST(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || (!parsed.data.undo && parsed.data.ml == null)) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const date = parsed.data.date ?? new Date().toISOString().slice(0, 10);
  try {
    const day = parsed.data.undo ? await undoLastWater(uid, date) : await addWater(uid, date, parsed.data.ml!);
    return NextResponse.json({ day });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 400 });
  }
}

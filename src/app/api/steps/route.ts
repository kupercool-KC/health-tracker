/**
 * POST /api/steps
 * Body: { text?: string, imageUrl?: string, steps?: number, date?: string, lang?: string }
 * Auth: Firebase ID token (Bearer).
 *
 * Manual daily step-count logging — a screenshot of a phone's health app,
 * a typed description, or a raw number. One doc per day
 * (users/{uid}/steps/{date}), last write wins (there's only one "today's
 * step count" per day, unlike meals/workouts which accumulate multiple
 * entries).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthFromRequest } from "@/lib/auth";
import { parseSteps } from "@/lib/steps/parser";
import { adminDb } from "@/lib/firebase/admin";
import { guardFreeText } from "@/lib/security/guardInput";
import type { DailySteps } from "@/lib/types";

const bodySchema = z
  .object({
    text: z.string().optional(),
    imageUrl: z.string().url().optional(),
    steps: z.number().nonnegative().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    lang: z.enum(["en", "he"]).optional(),
  })
  .refine((b) => b.text || b.imageUrl || b.steps != null, {
    message: "Provide text, imageUrl, or steps",
  });

export async function POST(req: Request) {
  const auth = await getAuthFromRequest(req);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { uid, email } = auth;

  const parsedBody = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsedBody.error.flatten() },
      { status: 400 },
    );
  }

  const { text, imageUrl, date, lang } = parsedBody.data;

  if (text?.trim()) {
    const guard = await guardFreeText({ uid, email, lang: lang ?? "en", text: text.trim(), context: "steps" });
    if (guard.flagged) {
      return NextResponse.json({ flagged: true, message: guard.message }, { status: 200 });
    }
  }

  let steps: number;
  if (parsedBody.data.steps != null) {
    steps = parsedBody.data.steps;
  } else {
    try {
      steps = (await parseSteps({ text, imageUrl })).steps;
    } catch (err) {
      return NextResponse.json({ error: "Failed to parse steps", detail: String(err) }, { status: 502 });
    }
  }

  const now = new Date().toISOString();
  const dateStr = date ?? now.slice(0, 10);

  const doc: DailySteps = {
    date: dateStr,
    steps,
    source: imageUrl ? "photo" : "manual",
    syncedAt: now,
  };

  await adminDb.collection("users").doc(uid).collection("steps").doc(dateStr).set(doc);

  return NextResponse.json(doc, { status: 201 });
}

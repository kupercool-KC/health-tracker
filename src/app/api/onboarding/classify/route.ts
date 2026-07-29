/**
 * POST /api/onboarding/classify
 * Body: { text: string, categories: { value: string, label: string }[] }
 * Auth: Firebase ID token (Bearer).
 *
 * Used by the onboarding wizard's "other" free-text boxes (workout types,
 * dietary preferences) to auto-select matching real categories instead of
 * leaving everything bucketed under "other" — see src/lib/onboarding/classify.ts.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getUidFromRequest } from "@/lib/auth";
import { classifyFreeText } from "@/lib/onboarding/classify";

const bodySchema = z.object({
  text: z.string().min(1),
  categories: z.array(z.object({ value: z.string(), label: z.string() })).min(1),
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

  const matched = await classifyFreeText(parsedBody.data.text, parsedBody.data.categories);
  return NextResponse.json({ matched });
}

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
import { getAuthFromRequest } from "@/lib/auth";
import { classifyFreeText } from "@/lib/onboarding/classify";
import { guardFreeText } from "@/lib/security/guardInput";

const bodySchema = z.object({
  text: z.string().min(1),
  categories: z.array(z.object({ value: z.string(), label: z.string() })).min(1),
  lang: z.enum(["en", "he"]).optional(),
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

  const { text, categories, lang } = parsedBody.data;

  const guard = await guardFreeText({ uid, email, lang: lang ?? "en", text, context: "onboarding-other" });
  if (guard.flagged) {
    return NextResponse.json({ flagged: true, message: guard.message }, { status: 200 });
  }

  const matched = await classifyFreeText(text, categories);
  return NextResponse.json({ matched });
}

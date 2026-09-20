/**
 * POST /api/chat/confirm
 * Body: { sessionId: string, messageIndex: number, kind: "meal" | "workout" | "steps" | "mealAction" }
 * Auth: Firebase ID token (Bearer).
 *
 * Clears the matching pending* field on one already-persisted chat message
 * once its proposal has actually been saved (via /api/nutrition,
 * /api/workouts, or /api/steps — the client calls this right after that
 * succeeds). Without this, the saved-but-still-"pending"-looking message
 * stays the session's last assistant message forever, and /api/chat's own
 * "is the user reacting to an open proposal" check keeps treating the
 * user's NEXT messages as corrections/follow-ups to a proposal that was
 * already saved, instead of starting fresh — the confirm buttons only ever
 * updated client-side UI state, never the persisted session.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getUidFromRequest } from "@/lib/auth";
import { adminDb } from "@/lib/firebase/admin";
import type { ChatMessage, ChatSession } from "@/lib/types";

const FIELD_BY_KIND = {
  meal: "pendingMeal",
  workout: "pendingWorkout",
  steps: "pendingSteps",
  mealAction: "pendingMealAction",
} as const satisfies Record<string, keyof ChatMessage>;

const bodySchema = z.object({
  sessionId: z.string().min(1),
  messageIndex: z.number().int().min(0),
  kind: z.enum(["meal", "workout", "steps", "mealAction"]),
});

export async function POST(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsedBody = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Invalid request", details: parsedBody.error.flatten() }, { status: 400 });
  }
  const { sessionId, messageIndex, kind } = parsedBody.data;
  const field = FIELD_BY_KIND[kind];

  // Scoped under the caller's own uid — same ownership guarantee as every
  // other route here (the doc simply doesn't exist under a different uid).
  const ref = adminDb.collection("users").doc(uid).collection("chatSessions").doc(sessionId);

  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const session = snap.data() as ChatSession | undefined;
    const target = session?.messages[messageIndex];
    if (!target || !(field in target)) return;
    const messages = [...session!.messages];
    const { [field]: _cleared, ...rest } = target;
    messages[messageIndex] = rest as ChatMessage;
    tx.update(ref, { messages });
  });

  return NextResponse.json({ ok: true });
}

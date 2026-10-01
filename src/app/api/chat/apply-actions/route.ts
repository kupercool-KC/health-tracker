/**
 * POST /api/chat/apply-actions
 * Body: { sessionId: string, messageIndex: number }
 * Auth: Firebase ID token (Bearer).
 *
 * The web Confirm button for a message's `pendingActions` (edits/deletes of
 * saved workouts/steps/weigh-ins, profile changes). Applies exactly what is
 * stored on the persisted message — the client never supplies the actions —
 * then clears the field so the proposal can't be applied twice.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getUidFromRequest } from "@/lib/auth";
import { adminDb } from "@/lib/firebase/admin";
import { applyPendingActions } from "@/lib/chat/applyActions";
import type { ChatMessage, ChatSession } from "@/lib/types";

const bodySchema = z.object({ sessionId: z.string().min(1), messageIndex: z.number().int().min(0) });

export async function POST(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const ref = adminDb.collection("users").doc(uid).collection("chatSessions").doc(parsed.data.sessionId);
  const session = (await ref.get()).data() as ChatSession | undefined;
  const target = session?.messages[parsed.data.messageIndex];
  if (!target?.pendingActions?.length) return NextResponse.json({ error: "Nothing to apply" }, { status: 404 });

  const result = await applyPendingActions(uid, target.pendingActions);
  const messages = [...session!.messages];
  const { pendingActions: _cleared, ...rest } = target;
  messages[parsed.data.messageIndex] = rest as ChatMessage;
  await ref.update({ messages });
  return NextResponse.json({ ok: result.failed.length === 0, ...result });
}

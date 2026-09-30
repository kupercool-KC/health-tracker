/**
 * GET /api/admin/whatsapp-review?token=<ADMIN_REVIEW_SECRET>&days=7
 *
 * Read-only export of recent WhatsApp conversation transcripts, for the
 * weekly review cloud agent (a Claude routine with no direct Firestore
 * access) to analyze for confusion patterns, misclassifications, and
 * feature requests. Not linked from any UI — token-gated like the Health
 * Sync ingest endpoint.
 *
 * For each linked WhatsApp user (see whatsappReminders, which already lists
 * everyone with a linked number), pulls their dedicated WhatsApp chat
 * session (users/{uid}/meta/whatsapp.sessionId) and returns messages from
 * the last N days, stripped of image URLs (irrelevant to a text review) but
 * keeping a `hadPending` flag — a proposal the user never confirmed is
 * itself a useful signal.
 */
import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import type { ChatMessage, ChatSession } from "@/lib/types";

function authorized(req: Request): boolean {
  const token = new URL(req.url).searchParams.get("token");
  return !!token && !!process.env.ADMIN_REVIEW_SECRET && token === process.env.ADMIN_REVIEW_SECRET;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Capped at 7 regardless of what's requested — this is a weekly review, and
  // a stray larger value (or a run that fires more often than expected)
  // shouldn't re-read further back than one week's worth of tokens.
  const days = Math.min(Number(new URL(req.url).searchParams.get("days") ?? "7") || 7, 7);
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceIso = since.toISOString();

  const linksSnap = await adminDb.collection("whatsappReminders").get();

  const results = await Promise.all(
    linksSnap.docs.map(async (linkDoc) => {
      const uid = linkDoc.id;
      const whatsappMetaSnap = await adminDb.collection("users").doc(uid).collection("meta").doc("whatsapp").get();
      const sessionId = (whatsappMetaSnap.data() as { sessionId?: string } | undefined)?.sessionId;
      if (!sessionId) return null;

      const sessionSnap = await adminDb.collection("users").doc(uid).collection("chatSessions").doc(sessionId).get();
      const session = sessionSnap.data() as ChatSession | undefined;
      if (!session) return null;

      const recentMessages = session.messages
        .filter((m) => m.createdAt >= sinceIso)
        .map((m: ChatMessage) => ({
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
          hadPending: !!(m.pendingMeal || m.pendingMealAction || m.pendingWorkout || m.pendingSteps || m.pendingBodyMetrics),
        }));
      if (recentMessages.length === 0) return null;

      return { uid, messages: recentMessages };
    }),
  );

  return NextResponse.json({ since: sinceIso, users: results.filter((r) => r !== null) });
}

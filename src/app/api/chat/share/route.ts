/**
 * POST /api/chat/share
 * Body: { sessionId: string }
 * Auth: Firebase ID token (Bearer).
 *
 * Snapshots a chat session's current title+messages into a new public
 * sharedChats/{shareId} doc — the *live* per-user session stays private;
 * the public link points at a copy taken at share time (edits/deletes to
 * the original afterward don't affect what was shared, and the live path
 * never needs a public-read rule).
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { z } from "zod";
import { getUidFromRequest } from "@/lib/auth";
import { adminDb } from "@/lib/firebase/admin";
import type { ChatSession, SharedChat } from "@/lib/types";

const bodySchema = z.object({ sessionId: z.string().min(1) });

export async function POST(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
  }

  const sessionSnap = await adminDb
    .collection("users")
    .doc(uid)
    .collection("chatSessions")
    .doc(parsed.data.sessionId)
    .get();
  if (!sessionSnap.exists) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const session = sessionSnap.data() as ChatSession;

  const shareId = crypto.randomBytes(16).toString("hex");
  const shared: SharedChat = {
    title: session.title,
    messages: session.messages,
    sharedAt: new Date().toISOString(),
  };
  await adminDb.collection("sharedChats").doc(shareId).set(shared);

  return NextResponse.json({ shareId }, { status: 201 });
}

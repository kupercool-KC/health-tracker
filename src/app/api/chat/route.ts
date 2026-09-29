/**
 * POST /api/chat
 * Body: { sessionId?: string, message?: string, imageUrls?: string[], lang?: "en"|"he" }
 * Auth: Firebase ID token (Bearer).
 *
 * Loads/creates a chat session, classifies intent, dispatches to the right
 * handler, appends both messages, saves, and (on the session's first
 * exchange) generates a title. Message *content* generation always goes
 * through this server route — the client can rename/delete a session
 * directly (see firestore.rules), but can't write fake assistant messages,
 * since only this route can produce them. The actual pipeline lives in
 * src/lib/chat/runChatTurn.ts (a route.ts file may only export the handful
 * of names Next.js recognizes, so it can't also export a reusable helper for
 * the WhatsApp webhook to call).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthFromRequest } from "@/lib/auth";
import { runChatTurn } from "@/lib/chat/runChatTurn";

const bodySchema = z
  .object({
    sessionId: z.string().optional(),
    message: z.string().optional(),
    // Up to 6 photos in one message — e.g. several angles of one dish, or a
    // menu page plus a closeup of one item.
    imageUrls: z.array(z.string().url()).min(1).max(6).optional(),
    lang: z.enum(["en", "he"]).optional().default("en"),
    // Client's local yyyy-mm-dd — used to scope "manage_meal" to today's
    // entries; the server has no timezone context (see /api/nutrition).
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    // Manual calorie/protein entered alongside a chat photo — see /api/nutrition's same fields.
    overrideCalories: z.number().nonnegative().optional(),
    overrideProtein: z.number().nonnegative().optional(),
  })
  .refine((b) => (b.message && b.message.trim().length > 0) || b.imageUrls?.length, {
    message: "Provide message or imageUrls",
  });

export async function POST(req: Request) {
  try {
    return await handleChat(req);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

async function handleChat(req: Request) {
  const auth = await getAuthFromRequest(req);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsedBody = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Invalid request", details: parsedBody.error.flatten() }, { status: 400 });
  }

  const result = await runChatTurn({ uid: auth.uid, email: auth.email, ...parsedBody.data });
  return NextResponse.json(result);
}

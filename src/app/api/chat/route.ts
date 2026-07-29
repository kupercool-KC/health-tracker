/**
 * POST /api/chat
 * Body: { sessionId?: string, message?: string, imageUrl?: string, lang?: "en"|"he" }
 * Auth: Firebase ID token (Bearer).
 *
 * Loads/creates a chat session, classifies intent, dispatches to the right
 * handler, appends both messages, saves, and (on the session's first
 * exchange) generates a title. Message *content* generation always goes
 * through this server route — the client can rename/delete a session
 * directly (see firestore.rules), but can't write fake assistant messages,
 * since only this route can produce them.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getUidFromRequest } from "@/lib/auth";
import { adminDb } from "@/lib/firebase/admin";
import { parseNutrition } from "@/lib/nutrition/parser";
import { strings } from "@/lib/i18n/strings";
import {
  answerGeneralHealth,
  answerHistoryQuery,
  classifyIntent,
  generateSessionTitle,
  outOfScopeReply,
  resolveMealAction,
} from "@/lib/chat/chat";
import type { ChatIntent, ChatMessage, ChatSession, UserProfile } from "@/lib/types";

const bodySchema = z
  .object({
    sessionId: z.string().optional(),
    message: z.string().optional(),
    imageUrl: z.string().url().optional(),
    lang: z.enum(["en", "he"]).optional().default("en"),
    // Client's local yyyy-mm-dd — used to scope "manage_meal" to today's
    // entries; the server has no timezone context (see /api/nutrition).
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .refine((b) => (b.message && b.message.trim().length > 0) || b.imageUrl, {
    message: "Provide message or imageUrl",
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
  const uid = await getUidFromRequest(req);
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsedBody = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Invalid request", details: parsedBody.error.flatten() }, { status: 400 });
  }
  const { sessionId, message, imageUrl, lang, date } = parsedBody.data;

  const sessionsCol = adminDb.collection("users").doc(uid).collection("chatSessions");
  const sessionRef = sessionId ? sessionsCol.doc(sessionId) : sessionsCol.doc();
  const now = new Date().toISOString();

  const snap = await sessionRef.get();
  const existing = snap.data() as ChatSession | undefined;
  const messages: ChatMessage[] = existing?.messages ?? [];

  const userContent = message?.trim() || (lang === "he" ? "[תמונה]" : "[photo]");
  messages.push({ role: "user", content: userContent, createdAt: now });

  // An image essentially always means "log this food" — skip the classifier
  // call entirely rather than trust it to guess right from a placeholder string.
  const intent: ChatIntent = imageUrl ? "log_meal" : await classifyIntent(userContent);
  const today = date ?? now.slice(0, 10);

  let replyContent: string;
  let pendingMeal: ChatMessage["pendingMeal"];
  let pendingMealAction: ChatMessage["pendingMealAction"];

  if (intent === "log_meal") {
    const parsed = await parseNutrition({ text: message, imageUrl, lang });
    pendingMeal = { ...parsed, ...(imageUrl ? { imageUrl } : {}) };

    const profileSnap = await adminDb.collection("users").doc(uid).collection("meta").doc("profile").get();
    const avoidFoods = (profileSnap.data() as UserProfile | undefined)?.avoidFoods ?? [];
    const hits = avoidFoods.filter((f) =>
      parsed.items.some((item) => item.description.toLowerCase().includes(f.toLowerCase())),
    );
    const warning =
      hits.length > 0
        ? lang === "he"
          ? `⚠️ שים לב: זה עשוי להכיל ${hits.join(", ")}, שסימנת כמאכל שאתה נמנע ממנו.\n`
          : `⚠️ Heads up: this looks like it contains ${hits.join(", ")}, which you've marked as a food to avoid.\n`
        : "";

    const lines = parsed.items
      .map(
        (item) =>
          `${item.description}: ${Math.round(item.calories)} kcal, ${Math.round(item.protein)}${strings.unitG[lang]} ${strings.protein[lang]}`,
      )
      .join("\n");

    replyContent = `${warning}${lines}\n` + (lang === "he" ? "לאשר ולשמור?" : "Confirm to save it?");
  } else if (intent === "query_history") {
    replyContent = await answerHistoryQuery(uid, userContent, lang, today);
  } else if (intent === "general_health") {
    replyContent = await answerGeneralHealth(userContent, lang);
  } else if (intent === "manage_meal") {
    const result = await resolveMealAction(uid, today, userContent, lang);
    replyContent = result.replyContent;
    pendingMealAction = result.pendingMealAction;
  } else {
    replyContent = outOfScopeReply(lang);
  }

  const assistantMsg: ChatMessage = {
    role: "assistant",
    content: replyContent,
    createdAt: new Date().toISOString(),
    // Firestore rejects `undefined` values, so only include these keys when
    // there's actually a pending action.
    ...(pendingMeal ? { pendingMeal } : {}),
    ...(pendingMealAction ? { pendingMealAction } : {}),
  };
  messages.push(assistantMsg);

  let title = existing?.title;
  if (!title) {
    title = await generateSessionTitle(userContent, replyContent, lang).catch(() => (lang === "he" ? "שיחה" : "Chat"));
  }

  const session: ChatSession = {
    id: sessionRef.id,
    title,
    messages,
    createdAt: existing?.createdAt ?? now,
    updatedAt: new Date().toISOString(),
  };
  await sessionRef.set(session);

  return NextResponse.json({ sessionId: sessionRef.id, reply: assistantMsg, title });
}

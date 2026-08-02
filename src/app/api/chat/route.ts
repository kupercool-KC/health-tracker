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
import { getAuthFromRequest } from "@/lib/auth";
import { adminDb } from "@/lib/firebase/admin";
import { parseNutrition } from "@/lib/nutrition/parser";
import { parseWorkout } from "@/lib/workout/parser";
import { parseSteps } from "@/lib/steps/parser";
import { strings } from "@/lib/i18n/strings";
import {
  answerGeneralHealth,
  answerHistoryQuery,
  classifyIntent,
  generateSessionTitle,
  outOfScopeReply,
  resolveLogDate,
  resolveMealAction,
} from "@/lib/chat/chat";
import { checkPromptSafety, securityReply } from "@/lib/chat/security";
import { sendSecurityAlert } from "@/lib/security/alertEmail";
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
    // Manual calorie/protein entered alongside a chat photo — see /api/nutrition's same fields.
    overrideCalories: z.number().nonnegative().optional(),
    overrideProtein: z.number().nonnegative().optional(),
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
  const auth = await getAuthFromRequest(req);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { uid, email } = auth;

  const parsedBody = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Invalid request", details: parsedBody.error.flatten() }, { status: 400 });
  }
  const { sessionId, message, imageUrl, lang, date, overrideCalories, overrideProtein } = parsedBody.data;

  const sessionsCol = adminDb.collection("users").doc(uid).collection("chatSessions");
  const sessionRef = sessionId ? sessionsCol.doc(sessionId) : sessionsCol.doc();
  const now = new Date().toISOString();

  const snap = await sessionRef.get();
  const existing = snap.data() as ChatSession | undefined;
  const messages: ChatMessage[] = existing?.messages ?? [];

  const userContent = message?.trim() || (lang === "he" ? "[תמונה]" : "[photo]");
  messages.push({ role: "user", content: userContent, createdAt: now });

  // Prompt-injection / jailbreak guard — only meaningful for actual typed
  // text, not an image upload (which produces the "[photo]" placeholder).
  const safety = message?.trim() ? await checkPromptSafety(message.trim()) : { flagged: false };

  // A bare image with no text essentially always means "log this food" —
  // skip the classifier call entirely rather than trust it to guess right
  // from a placeholder string. But an image WITH text ("log this workout")
  // still goes through the classifier so it can route to log_workout/log_steps.
  const intent: ChatIntent = safety.flagged
    ? "out_of_scope"
    : imageUrl && !message?.trim()
      ? "log_meal"
      : await classifyIntent(userContent);
  const today = date ?? now.slice(0, 10);

  let replyContent: string;
  let pendingMeal: ChatMessage["pendingMeal"];
  let pendingMealAction: ChatMessage["pendingMealAction"];
  let pendingWorkout: ChatMessage["pendingWorkout"];
  let pendingSteps: ChatMessage["pendingSteps"];

  if (safety.flagged) {
    replyContent = securityReply(lang);
  } else if (intent === "log_meal") {
    let parsed = await parseNutrition({ text: message, imageUrl, lang });
    if ((overrideCalories != null || overrideProtein != null) && parsed.items.length === 1) {
      const [item] = parsed.items;
      parsed = {
        items: [
          {
            ...item,
            ...(overrideCalories != null ? { calories: overrideCalories } : {}),
            ...(overrideProtein != null ? { protein: overrideProtein } : {}),
          },
        ],
      };
    }
    // Only worth a date-resolution call when there's actual text to resolve
    // against — an image-only message ("[photo]" placeholder) has no
    // calendar phrase to find, so it always means today.
    const targetDate = message?.trim() ? await resolveLogDate(message.trim(), today) : today;
    pendingMeal = { ...parsed, ...(imageUrl ? { imageUrl } : {}), date: targetDate };

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

    const dateNote = targetDate !== today ? ` (${targetDate})` : "";
    replyContent = `${warning}${lines}${dateNote}\n` + (lang === "he" ? "לאשר ולשמור?" : "Confirm to save it?");
  } else if (intent === "log_workout") {
    const parsed = await parseWorkout({ text: message, imageUrl, lang });
    const targetDate = message?.trim() ? await resolveLogDate(message.trim(), today) : today;
    pendingWorkout = { ...parsed, ...(imageUrl ? { imageUrl } : {}), date: targetDate };

    const dateNote = targetDate !== today ? ` (${targetDate})` : "";
    const summary =
      `${parsed.type}: ${Math.round(parsed.durationSec / 60)} min` +
      (parsed.distanceMeters != null ? `, ${(parsed.distanceMeters / 1000).toFixed(1)} km` : "") +
      (parsed.calories != null ? `, ${Math.round(parsed.calories)} kcal` : "");
    replyContent = `${summary}${dateNote}\n` + (lang === "he" ? "לאשר ולשמור?" : "Confirm to save it?");
  } else if (intent === "log_steps") {
    const parsed = await parseSteps({ text: message, imageUrl });
    const targetDate = message?.trim() ? await resolveLogDate(message.trim(), today) : today;
    pendingSteps = { steps: parsed.steps, date: targetDate };

    const dateNote = targetDate !== today ? ` (${targetDate})` : "";
    replyContent =
      `${parsed.steps} ${strings.steps[lang].toLowerCase()}${dateNote}\n` +
      (lang === "he" ? "לאשר ולשמור?" : "Confirm to save it?");
  } else if (intent === "query_history") {
    replyContent = await answerHistoryQuery(uid, userContent, lang, today);
  } else if (intent === "general_health") {
    replyContent = await answerGeneralHealth(userContent, lang, today);
  } else if (intent === "manage_meal") {
    const result = await resolveMealAction(uid, today, userContent, lang);
    replyContent = result.replyContent;
    pendingMealAction = result.pendingMealAction;
  } else {
    replyContent = outOfScopeReply(lang);
  }

  if (safety.flagged) {
    await sendSecurityAlert({
      uid,
      email,
      sessionId: sessionId ?? sessionRef.id,
      question: userContent,
      answer: replyContent,
      reason: safety.reason,
      createdAt: now,
    });
  }

  const assistantMsg: ChatMessage = {
    role: "assistant",
    content: replyContent,
    createdAt: new Date().toISOString(),
    // Firestore rejects `undefined` values, so only include these keys when
    // there's actually a pending action.
    ...(pendingMeal ? { pendingMeal } : {}),
    ...(pendingMealAction ? { pendingMealAction } : {}),
    ...(pendingWorkout ? { pendingWorkout } : {}),
    ...(pendingSteps ? { pendingSteps } : {}),
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

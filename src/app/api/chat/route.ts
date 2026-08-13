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
  genericMealDescription,
  generateSessionTitle,
  greetingReply,
  isGreeting,
  missingGenericMealInfoReply,
  outOfScopeReply,
  parseFailureReply,
  parseGenericMealTotals,
  resolveLogDate,
  resolveLogFromPriorAnswer,
  resolveMealAction,
  resolvePendingMealFollowUp,
  summarizeProfileForChat,
} from "@/lib/chat/chat";
import { checkPromptSafety, securityReply } from "@/lib/chat/security";
import { sendSecurityAlert } from "@/lib/security/alertEmail";
import type { ChatIntent, ChatMessage, ChatSession, ParsedNutrition, UserProfile } from "@/lib/types";

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

  // Fetched once and reused by both log_meal's avoid-food warning and
  // general_health's personalization — same doc, no reason to read it twice.
  const profileSnap = await adminDb.collection("users").doc(uid).collection("meta").doc("profile").get();
  const profile = profileSnap.data() as UserProfile | undefined;

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

  // History excludes the message just pushed above — classifyIntent/
  // answerGeneralHealth take it separately and append it themselves.
  const priorMessages = messages.slice(0, -1);

  // Once a pendingMeal proposal is on screen (unconfirmed — "Confirm to
  // save it?"), the user's very next message is often about THAT specific
  // proposal — a correction ("no, it's 249") or a question ("why 468
  // calories?") — not a request to log something new. Previously every
  // message re-ran log_meal's parseNutrition from scratch regardless, which
  // has no memory of the number just discussed and (being deterministic at
  // temperature 0) kept regenerating the exact same wrong estimate no
  // matter what the user said, ignoring corrections and questions alike.
  const lastMessage = priorMessages.at(-1);
  const openPendingMeal = !safety.flagged && lastMessage?.role === "assistant" ? lastMessage.pendingMeal : undefined;
  const today = date ?? now.slice(0, 10);
  const pendingMealFollowUp =
    openPendingMeal && message?.trim()
      ? await resolvePendingMealFollowUp(message.trim(), openPendingMeal, lang, priorMessages, today)
      : null;
  const followUpHandled = !!pendingMealFollowUp && pendingMealFollowUp.kind !== "new";

  // A bare image with no text and no prior conversation essentially always
  // means "log this food" — skip the classifier entirely rather than trust
  // it to guess right from just a placeholder string. But when there IS
  // prior conversation, a captionless photo might be answering an open
  // general_health question ("send me a photo of the menu/dish") instead
  // of starting a fresh log — let the (now history-aware) classifier decide
  // rather than blindly assuming log_meal, which previously sent a restaurant
  // menu screenshot straight into meal-logging's vision parser and produced
  // confidently wrong, unrelated dish names with no way to say "I don't know".
  const bareImageNoHistory = !!imageUrl && !message?.trim() && priorMessages.length === 0;

  // A bare greeting ("hi", "שלום") isn't a nutrition/fitness question, but
  // answering it with the same hard out_of_scope refusal used for genuinely
  // unrelated requests reads as needlessly blunt for what's often the very
  // first thing a user types. Handled before classification, as its own
  // free/instant fast path, rather than letting it fall through to the
  // classifier and the canned refusal.
  const greeting = !safety.flagged && !imageUrl && !!message?.trim() && isGreeting(message);

  // Skip the classifier call entirely once the pending-meal follow-up has
  // already resolved this turn — one fewer model call, and its intent
  // would be irrelevant anyway.
  const intent: ChatIntent = followUpHandled
    ? "log_meal"
    : safety.flagged
      ? "out_of_scope"
      : greeting
        ? "out_of_scope"
        : bareImageNoHistory
          ? "log_meal"
          : await classifyIntent(userContent, priorMessages);

  let replyContent: string;
  let pendingMeal: ChatMessage["pendingMeal"];
  let pendingMealAction: ChatMessage["pendingMealAction"];
  let pendingWorkout: ChatMessage["pendingWorkout"];
  let pendingSteps: ChatMessage["pendingSteps"];

  if (followUpHandled) {
    replyContent = pendingMealFollowUp!.replyContent!;
    pendingMeal = pendingMealFollowUp!.pendingMeal;
  } else if (safety.flagged) {
    replyContent = securityReply(lang);
  } else if (greeting) {
    replyContent = greetingReply(lang);
  } else if (intent === "log_meal") {
    try {
      // "add it"/"log it" right after a general_health answer that already
      // computed a specific total (not a pendingMeal — that case is handled
      // above by resolvePendingMealFollowUp) previously still went through
      // parseNutrition from scratch, which has no memory of that number and
      // regularly produced a different, ungrounded guess of its own. Try
      // reusing the number that was already given before re-deriving one.
      const reused = !imageUrl ? await resolveLogFromPriorAnswer(message ?? "", priorMessages, lang, today) : null;

      // Some meals are too large/mixed to name a specific dish for —
      // "ate a huge mixed meal, ~900 calories and 50g protein" — the user
      // just wants to log the stated totals directly rather than have
      // parseNutrition estimate/ground against a food it can't identify.
      const generic =
        !reused && !imageUrl && message?.trim() ? await parseGenericMealTotals(message.trim(), lang, priorMessages) : null;

      if (generic?.isGenericTotals && (generic.calories == null || generic.protein == null)) {
        // Not enough to save yet — ask for exactly what's missing rather
        // than guessing a number for the unstated field. No pendingMeal.
        replyContent = missingGenericMealInfoReply(lang, generic.calories == null, generic.protein == null);
      } else {
        let parsed: ParsedNutrition;
        let targetDate: string;
        if (reused) {
          parsed = reused.parsed;
          targetDate = reused.date ?? today;
        } else if (generic?.isGenericTotals && generic.calories != null && generic.protein != null) {
          parsed = { items: [{ description: genericMealDescription(lang), calories: generic.calories, protein: generic.protein }] };
          targetDate = message?.trim() ? await resolveLogDate(message.trim(), today) : today;
        } else {
          parsed = await parseNutrition({ text: message, imageUrl, lang, history: priorMessages });
          // Only worth a date-resolution call when there's actual text to
          // resolve against — an image-only message ("[photo]" placeholder)
          // has no calendar phrase to find, so it always means today.
          targetDate = message?.trim() ? await resolveLogDate(message.trim(), today) : today;
        }

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
        pendingMeal = { ...parsed, ...(imageUrl ? { imageUrl } : {}), date: targetDate };

        const avoidFoods = profile?.avoidFoods ?? [];
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
      }
    } catch (err) {
      // Nothing extractable (no food named anywhere nearby, or the model's
      // output failed schema validation) previously threw all the way out to
      // the route's generic catch-all 500 ("Internal error" with no way to
      // recover). Give the user a next step instead of a dead end.
      console.error("[chat] parseNutrition failed:", err);
      pendingMeal = undefined;
      replyContent = parseFailureReply(lang);
    }
  } else if (intent === "log_workout") {
    try {
      const parsed = await parseWorkout({ text: message, imageUrl, lang, history: priorMessages });
      const targetDate = message?.trim() ? await resolveLogDate(message.trim(), today) : today;
      pendingWorkout = { ...parsed, ...(imageUrl ? { imageUrl } : {}), date: targetDate };

      const dateNote = targetDate !== today ? ` (${targetDate})` : "";
      const summary =
        `${parsed.type}: ${Math.round(parsed.durationSec / 60)} min` +
        (parsed.distanceMeters != null ? `, ${(parsed.distanceMeters / 1000).toFixed(1)} km` : "") +
        (parsed.calories != null ? `, ${Math.round(parsed.calories)} kcal` : "");
      replyContent = `${summary}${dateNote}\n` + (lang === "he" ? "לאשר ולשמור?" : "Confirm to save it?");
    } catch (err) {
      console.error("[chat] parseWorkout failed:", err);
      replyContent = parseFailureReply(lang);
    }
  } else if (intent === "log_steps") {
    try {
      const parsed = await parseSteps({ text: message, imageUrl, history: priorMessages });
      const targetDate = message?.trim() ? await resolveLogDate(message.trim(), today) : today;
      pendingSteps = { steps: parsed.steps, date: targetDate };

      const dateNote = targetDate !== today ? ` (${targetDate})` : "";
      replyContent =
        `${parsed.steps} ${strings.steps[lang].toLowerCase()}${dateNote}\n` +
        (lang === "he" ? "לאשר ולשמור?" : "Confirm to save it?");
    } catch (err) {
      console.error("[chat] parseSteps failed:", err);
      replyContent = parseFailureReply(lang);
    }
  } else if (intent === "query_history") {
    replyContent = await answerHistoryQuery(uid, userContent, lang, today, priorMessages);
  } else if (intent === "general_health") {
    replyContent = await answerGeneralHealth(
      uid,
      userContent,
      lang,
      today,
      priorMessages,
      imageUrl,
      summarizeProfileForChat(profile),
    );
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

/**
 * The full intent-classify-and-respond pipeline behind POST /api/chat,
 * minus request auth/parsing — factored out into its own module (rather
 * than living in the route file) because a Next.js route.ts file may only
 * export the handful of names Next recognizes (GET/POST/etc, a few config
 * values), so an extra reusable export there fails the build. Both
 * /api/chat/route.ts (a browser session with a Firebase ID token) and the
 * WhatsApp webhook (a uid already resolved from a linked phone number, no
 * browser session at all) call this to drive the exact same chat behavior,
 * instead of the webhook reimplementing meal/workout/steps/body-metrics
 * parsing and intent routing from scratch.
 */
import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { parseNutrition } from "@/lib/nutrition/parser";
import { parseWorkout } from "@/lib/workout/parser";
import { parseSteps } from "@/lib/steps/parser";
import { parseBodyMetrics } from "@/lib/bodyMetrics/parser";
import { strings } from "@/lib/i18n/strings";
import type { CompositeLogDetection } from "@/lib/chat/chat";
import {
  answerGeneralHealth,
  answerHistoryQuery,
  classifyIntent,
  detectCompositeLog,
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
  resolvePendingWorkoutFollowUp,
  summarizeProfileForChat,
} from "@/lib/chat/chat";
import { checkPromptSafety, securityReply } from "@/lib/chat/security";
import { sendSecurityAlert } from "@/lib/security/alertEmail";
import { resolveReminderAction } from "@/lib/reminders/manage";
import type { ChatIntent, ChatMessage, ChatSession, ParsedNutrition, UserProfile } from "@/lib/types";

export interface ChatTurnInput {
  uid: string;
  email?: string;
  sessionId?: string;
  message?: string;
  imageUrls?: string[];
  lang: "en" | "he";
  date?: string;
  overrideCalories?: number;
  overrideProtein?: number;
  /** WhatsApp id of this incoming message, stored so later quote-replies/reactions can refer back to it. */
  waMessageId?: string;
  /** WhatsApp id of the older message this one quote-replies to — used as the reference for follow-ups. */
  quotedWaId?: string;
}

export interface ChatTurnResult {
  sessionId: string;
  reply: ChatMessage;
  title: string;
}

export async function runChatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
  const { uid, email, sessionId, message: rawMessage, imageUrls, lang, date, overrideCalories, overrideProtein, waMessageId, quotedWaId } = input;

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

  const quoted = quotedWaId ? messages.find((m) => m.waId === quotedWaId) : undefined;
  const quotePreview = quoted ? quoted.content.replace(/\s+/g, " ").slice(0, 300) : undefined;
  const message =
    quotePreview && rawMessage?.trim()
      ? lang === "he"
        ? `(בתגובה להודעה: "${quotePreview}")\n${rawMessage.trim()}`
        : `(replying to the message: "${quotePreview}")\n${rawMessage.trim()}`
      : rawMessage;

  const multiplePhotos = (imageUrls?.length ?? 0) > 1;
  const userContent =
    message?.trim() || (lang === "he" ? (multiplePhotos ? "[תמונות]" : "[תמונה]") : multiplePhotos ? "[photos]" : "[photo]");
  messages.push({ role: "user", content: userContent, createdAt: now, ...(waMessageId ? { waId: waMessageId } : {}) });

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
  const lastMessage = quoted ?? priorMessages.at(-1);
  const openPendingMeal = !safety.flagged && lastMessage?.role === "assistant" ? lastMessage.pendingMeal : undefined;
  const today = date ?? now.slice(0, 10);
  const pendingMealFollowUp =
    openPendingMeal && message?.trim()
      ? await resolvePendingMealFollowUp(message.trim(), openPendingMeal, lang, priorMessages, today)
      : null;
  const followUpHandled = !!pendingMealFollowUp && pendingMealFollowUp.kind !== "new";

  // Same idea, for an open (unconfirmed) workout proposal — see
  // resolvePendingWorkoutFollowUp's doc comment. Only checked when the meal
  // follow-up above didn't already claim this message, so one message never
  // gets interpreted against two different open proposals at once.
  const openPendingWorkout =
    !followUpHandled && !safety.flagged && lastMessage?.role === "assistant" ? lastMessage.pendingWorkout : undefined;
  const pendingWorkoutFollowUp =
    openPendingWorkout && message?.trim()
      ? await resolvePendingWorkoutFollowUp(message.trim(), openPendingWorkout, lang, priorMessages, today)
      : null;
  const workoutFollowUpHandled = !!pendingWorkoutFollowUp && pendingWorkoutFollowUp.kind !== "new";

  // A bare greeting ("hi", "שלום") isn't a nutrition/fitness question, but
  // answering it with the same hard out_of_scope refusal used for genuinely
  // unrelated requests reads as needlessly blunt for what's often the very
  // first thing a user types. Handled before classification, as its own
  // free/instant fast path, rather than letting it fall through to the
  // classifier and the canned refusal.
  const greeting = !safety.flagged && !imageUrls?.length && !!message?.trim() && isGreeting(message);

  // Skip the classifier call entirely once the pending-meal follow-up has
  // already resolved this turn — one fewer model call, and its intent
  // would be irrelevant anyway. When none of the fast paths apply, also
  // check (in parallel, same message — no added latency) whether this one
  // message actually describes MORE than one kind of log at once (e.g. a
  // meal AND a workout together) — classifyIntent alone can only pick one
  // bucket, which silently dropped the other half.
  const skipClassifier = followUpHandled || workoutFollowUpHandled || safety.flagged || greeting;
  const [classifiedIntent, composite] = skipClassifier
    ? [null as ChatIntent | null, { logs: [] } as CompositeLogDetection]
    : await Promise.all([
        classifyIntent(userContent, priorMessages, imageUrls),
        imageUrls?.length ? Promise.resolve({ logs: [] }) : detectCompositeLog(userContent, priorMessages),
      ]);
  let intent: ChatIntent = followUpHandled
    ? "log_meal"
    : workoutFollowUpHandled
      ? "log_workout"
      : safety.flagged
        ? "out_of_scope"
        : greeting
          ? "out_of_scope"
          : classifiedIntent!;

  // Second line of defense for a misclassified "add X for yesterday" — the
  // edit path would otherwise latch onto some same-named entry from another
  // day and propose changing it.
  let mealActionResult: Awaited<ReturnType<typeof resolveMealAction>> | undefined;
  if (intent === "manage_meal") {
    mealActionResult = await resolveMealAction(uid, today, userContent, lang);
    if (mealActionResult.isNewLog) intent = "log_meal";
  }
  const isComposite = composite.logs.length >= 2 && !!message?.trim();

  let replyContent: string;
  let pendingMeal: ChatMessage["pendingMeal"];
  let pendingMealAction: ChatMessage["pendingMealAction"];
  let pendingWorkout: ChatMessage["pendingWorkout"];
  let pendingSteps: ChatMessage["pendingSteps"];
  let pendingBodyMetrics: ChatMessage["pendingBodyMetrics"];

  if (followUpHandled) {
    replyContent = pendingMealFollowUp!.replyContent!;
    pendingMeal = pendingMealFollowUp!.pendingMeal;
  } else if (workoutFollowUpHandled) {
    replyContent = pendingWorkoutFollowUp!.replyContent!;
    pendingWorkout = pendingWorkoutFollowUp!.pendingWorkout;
  } else if (safety.flagged) {
    replyContent = securityReply(lang);
  } else if (greeting) {
    replyContent = greetingReply(lang);
  } else if (isComposite) {
    // One message described more than one kind of thing to log at once
    // (e.g. a meal AND a workout) — parse each detected category in
    // parallel and build one reply with an independent pendingX per
    // category, so the client renders a separate Confirm button for each
    // (see ChatPanel.tsx — a message can carry multiple pending* fields).
    try {
      const summaries: string[] = [];
      await Promise.all([
        composite.logs.includes("meal")
          ? (async () => {
              try {
                const parsed = await parseNutrition({ text: message, lang, history: priorMessages });
                const targetDate = message?.trim() ? await resolveLogDate(message.trim(), today) : today;
                pendingMeal = { ...parsed, date: targetDate };
                const lines = parsed.items
                  .map(
                    (item) =>
                      `${item.description}: ${Math.round(item.calories)} kcal, ${Math.round(item.protein)}${strings.unitG[lang]} ${strings.protein[lang]}`,
                  )
                  .join("\n");
                const dateNote = targetDate !== today ? ` (${targetDate})` : "";
                summaries.push(`${lines}${dateNote}`);
              } catch (err) {
                console.error("[chat] composite parseNutrition failed:", err);
              }
            })()
          : Promise.resolve(),
        composite.logs.includes("workout")
          ? (async () => {
              try {
                const parsed = await parseWorkout({ text: message, lang, history: priorMessages });
                const targetDate = message?.trim() ? await resolveLogDate(message.trim(), today) : today;
                pendingWorkout = { ...parsed, date: targetDate };
                const dateNote = targetDate !== today ? ` (${targetDate})` : "";
                const summary =
                  `${parsed.type}: ${Math.round(parsed.durationSec / 60)} min` +
                  (parsed.distanceMeters != null ? `, ${(parsed.distanceMeters / 1000).toFixed(1)} km` : "") +
                  (parsed.calories != null ? `, ${Math.round(parsed.calories)} kcal` : "");
                summaries.push(`${summary}${dateNote}`);
              } catch (err) {
                console.error("[chat] composite parseWorkout failed:", err);
              }
            })()
          : Promise.resolve(),
        composite.logs.includes("steps")
          ? (async () => {
              try {
                const parsed = await parseSteps({ text: message, history: priorMessages });
                const targetDate = message?.trim() ? await resolveLogDate(message.trim(), today) : today;
                pendingSteps = { steps: parsed.steps, date: targetDate };
                const dateNote = targetDate !== today ? ` (${targetDate})` : "";
                summaries.push(`${parsed.steps} ${strings.steps[lang].toLowerCase()}${dateNote}`);
              } catch (err) {
                console.error("[chat] composite parseSteps failed:", err);
              }
            })()
          : Promise.resolve(),
      ]);

      replyContent =
        summaries.length > 0
          ? `${summaries.join("\n\n")}\n` + (lang === "he" ? "לאשר ולשמור כל אחד?" : "Confirm each to save it?")
          : parseFailureReply(lang);
    } catch (err) {
      console.error("[chat] composite log failed:", err);
      replyContent = parseFailureReply(lang);
    }
  } else if (intent === "log_meal") {
    try {
      // "add it"/"log it" right after a general_health answer that already
      // computed a specific total (not a pendingMeal — that case is handled
      // above by resolvePendingMealFollowUp) previously still went through
      // parseNutrition from scratch, which has no memory of that number and
      // regularly produced a different, ungrounded guess of its own. Try
      // reusing the number that was already given before re-deriving one.
      const reused = !imageUrls?.length ? await resolveLogFromPriorAnswer(message ?? "", priorMessages, lang, today) : null;

      // Some meals are too large/mixed to name a specific dish for —
      // "ate a huge mixed meal, ~900 calories and 50g protein" — the user
      // just wants to log the stated totals directly rather than have
      // parseNutrition estimate/ground against a food it can't identify.
      const generic =
        !reused && !imageUrls?.length && message?.trim()
          ? await parseGenericMealTotals(message.trim(), lang, priorMessages)
          : null;

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
          parsed = await parseNutrition({ text: message, imageUrls, lang, history: priorMessages });
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
        pendingMeal = { ...parsed, ...(imageUrls?.length ? { imageUrls } : {}), date: targetDate };

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

        // A restaurant was named but its actual menu/ingredients for this
        // dish couldn't be found online (parseNutrition fell back to a
        // generic estimate) — say so plainly and invite the real values,
        // rather than silently presenting a guess as if it were grounded.
        const menuNotFoundNotes = parsed.items
          .filter((item) => item.restaurantMenuNotFound)
          .map((item) => {
            const assumedIngredients = item.ingredients?.length ? item.ingredients.join(", ") : null;
            return lang === "he"
              ? `לא מצאתי את התפריט המדויק של ${item.restaurantName} עבור "${item.description}"${assumedIngredients ? ` — ההערכה מבוססת על מרכיבים טיפוסיים למנה כזו: ${assumedIngredients}` : " — ההערכה מבוססת על מרכיבים טיפוסיים למנה כזו"}. אם אתה מכיר את המרכיבים או הערכים המדויקים מהתפריט, ספר לי ואעדכן.`
              : `I couldn't find ${item.restaurantName}'s exact menu for "${item.description}"${assumedIngredients ? ` — this estimate assumes: ${assumedIngredients}` : " — this estimate is based on typical ingredients for that kind of dish"}. If you know the real ingredients or values from the menu, let me know and I'll update it.`;
          });
        const menuNote = menuNotFoundNotes.length > 0 ? `\n\n${menuNotFoundNotes.join("\n")}` : "";

        const dateNote = targetDate !== today ? ` (${targetDate})` : "";
        replyContent = `${warning}${lines}${dateNote}${menuNote}\n` + (lang === "he" ? "לאשר ולשמור?" : "Confirm to save it?");
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
      const parsed = await parseWorkout({ text: message, imageUrls, lang, history: priorMessages });
      const targetDate = message?.trim() ? await resolveLogDate(message.trim(), today) : today;
      pendingWorkout = { ...parsed, ...(imageUrls?.length ? { imageUrls } : {}), date: targetDate };

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
      const parsed = await parseSteps({ text: message, imageUrls, history: priorMessages });
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
  } else if (intent === "log_body_metrics") {
    try {
      const parsed = await parseBodyMetrics({ text: message, imageUrls, history: priorMessages });
      if (Object.keys(parsed).length === 0) {
        replyContent = parseFailureReply(lang);
      } else {
        const targetDate = message?.trim() ? await resolveLogDate(message.trim(), today) : today;
        pendingBodyMetrics = { ...parsed, ...(imageUrls?.length ? { imageUrls } : {}), date: targetDate };

        const dateNote = targetDate !== today ? ` (${targetDate})` : "";
        const lines: string[] = [];
        if (parsed.weightKg != null) lines.push(`${strings.weightLabel[lang]}: ${parsed.weightKg}`);
        if (parsed.bmi != null) lines.push(`BMI: ${parsed.bmi}`);
        if (parsed.muscleMassKg != null) lines.push(`${strings.muscleMassLabel[lang]}: ${parsed.muscleMassKg} ${strings.unitKg[lang]}`);
        if (parsed.bodyFatPercent != null) lines.push(`${strings.bodyFatLabel[lang]}: ${parsed.bodyFatPercent}%`);
        if (parsed.visceralFat != null) lines.push(`${strings.visceralFatLabel[lang]}: ${parsed.visceralFat}`);
        if (parsed.bodyWaterPercent != null) lines.push(`${strings.bodyWaterLabel[lang]}: ${parsed.bodyWaterPercent}%`);
        if (parsed.basalMetabolicRate != null) lines.push(`${strings.bmrLabel[lang]}: ${parsed.basalMetabolicRate} kcal`);
        if (parsed.proteinPercent != null) lines.push(`${strings.proteinPercentLabel[lang]}: ${parsed.proteinPercent}%`);
        replyContent = `${lines.join("\n")}${dateNote}\n` + (lang === "he" ? "לאשר ולשמור?" : "Confirm to save it?");
      }
    } catch (err) {
      console.error("[chat] parseBodyMetrics failed:", err);
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
      imageUrls,
      summarizeProfileForChat(profile),
    );
  } else if (intent === "manage_meal" && mealActionResult) {
    replyContent = mealActionResult.replyContent;
    pendingMealAction = mealActionResult.pendingMealAction;
  } else if (intent === "manage_reminder") {
    const result = await resolveReminderAction(uid, userContent, lang, priorMessages);
    replyContent = result.replyContent;
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
    ...(pendingBodyMetrics ? { pendingBodyMetrics } : {}),
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

  return { sessionId: sessionRef.id, reply: assistantMsg, title };
}

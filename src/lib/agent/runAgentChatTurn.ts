/**
 * Session-aware wrapper around runAgent: loads/saves the chat session, runs
 * the safety guard, carries the open proposal (draft) forward, and returns
 * the same ChatTurnResult shape the legacy pipeline does — so /api/chat, the
 * WhatsApp webhook and ChatPanel are untouched.
 *
 * Invariant kept here: at most ONE assistant message in a session holds an
 * open proposal (the newest). Older open proposals are moved into the new
 * reply's draft (or dropped if the agent removed them) — never left behind
 * as orphans that a later "כן" could save a second time.
 */
import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { checkPromptSafety, securityReply } from "@/lib/chat/security";
import { sendSecurityAlert } from "@/lib/security/alertEmail";
import { generateSessionTitle, parseFailureReply } from "@/lib/chat/chat";
import type { ChatTurnInput, ChatTurnResult } from "@/lib/chat/runChatTurn";
import { runAgent } from "./agent";
import { buildAgentState, draftFromMessage, findOpenProposalIndex, hasPending } from "./state";
import type { ChatMessage, ChatSession } from "@/lib/types";

let cached: { at: number; enabled: boolean } | null = null;

/** Kill switch: set appConfig/chatAgent.enabled = false in Firestore to fall back to the legacy pipeline instantly. Default on. */
export async function isAgentEnabled(): Promise<boolean> {
  if (cached && Date.now() - cached.at < 60_000) return cached.enabled;
  let enabled = true;
  try {
    const data = (await adminDb.collection("appConfig").doc("chatAgent").get()).data() as { enabled?: boolean } | undefined;
    if (data?.enabled === false) enabled = false;
  } catch {
    // config read failure must not take the bot down — default to enabled
  }
  cached = { at: Date.now(), enabled };
  return enabled;
}

function stripPending(m: ChatMessage): ChatMessage {
  const { pendingMeal, pendingMealAction, pendingWorkout, pendingSteps, pendingBodyMetrics, pendingActions, ...rest } = m;
  void pendingActions;
  void pendingMeal;
  void pendingMealAction;
  void pendingWorkout;
  void pendingSteps;
  void pendingBodyMetrics;
  return rest as ChatMessage;
}

export async function runAgentChatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
  const { uid, email, sessionId, message: rawMessage, imageUrls, lang, date, overrideCalories, overrideProtein, waMessageId, quotedWaId } = input;

  const sessionsCol = adminDb.collection("users").doc(uid).collection("chatSessions");
  const sessionRef = sessionId ? sessionsCol.doc(sessionId) : sessionsCol.doc();
  const now = new Date().toISOString();
  const today = date ?? now.slice(0, 10);

  const existing = (await sessionRef.get()).data() as ChatSession | undefined;
  const prior: ChatMessage[] = existing?.messages ?? [];

  const quoted = quotedWaId ? prior.find((m) => m.waId === quotedWaId) : undefined;
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
  const userMsg: ChatMessage = { role: "user", content: userContent, createdAt: now, ...(waMessageId ? { waId: waMessageId } : {}) };

  const safety = message?.trim() ? await checkPromptSafety(message.trim()) : { flagged: false };

  let replyContent: string;
  let draft: ReturnType<typeof draftFromMessage> = {};
  // All older messages lose their pending fields — the open one (if any) is carried into the new reply's draft.
  const openIdx = safety.flagged ? -1 : findOpenProposalIndex(prior);
  const carried = openIdx >= 0 ? draftFromMessage(prior[openIdx]) : {};
  const cleaned = prior.map((m) => (hasPending(m) ? stripPending(m) : m));

  if (safety.flagged) {
    replyContent = securityReply(lang);
  } else {
    const state = await buildAgentState(uid, today, now);
    const out = await runAgent({ uid, lang, today, userMessage: userContent, imageUrls, priorMessages: prior, state, draft: carried });
    replyContent = out.replyContent.trim() || parseFailureReply(lang);
    draft = out.draft;

    if ((overrideCalories != null || overrideProtein != null) && draft.meal?.items.length === 1) {
      const [item] = draft.meal.items;
      draft.meal.items = [{ ...item, ...(overrideCalories != null ? { calories: overrideCalories } : {}), ...(overrideProtein != null ? { protein: overrideProtein } : {}), nutritionSource: "manual" }];
    }
  }

  if (safety.flagged) {
    await sendSecurityAlert({ uid, email, sessionId: sessionId ?? sessionRef.id, question: userContent, answer: replyContent, reason: safety.reason, createdAt: now });
  }

  const assistantMsg: ChatMessage = {
    role: "assistant",
    content: replyContent,
    createdAt: new Date().toISOString(),
    ...(draft.meal ? { pendingMeal: draft.meal } : {}),
    ...(draft.mealAction ? { pendingMealAction: draft.mealAction } : {}),
    ...(draft.workout ? { pendingWorkout: draft.workout } : {}),
    ...(draft.steps ? { pendingSteps: draft.steps } : {}),
    ...(draft.bodyMetrics ? { pendingBodyMetrics: draft.bodyMetrics } : {}),
    ...(draft.actions?.length ? { pendingActions: draft.actions } : {}),
  };
  const messages = [...cleaned, userMsg, assistantMsg];

  let title = existing?.title;
  if (!title) title = await generateSessionTitle(userContent, replyContent, lang).catch(() => (lang === "he" ? "שיחה" : "Chat"));

  const session: ChatSession = { id: sessionRef.id, title, messages, createdAt: existing?.createdAt ?? now, updatedAt: new Date().toISOString() };
  await sessionRef.set(session);
  return { sessionId: sessionRef.id, reply: assistantMsg, title };
}

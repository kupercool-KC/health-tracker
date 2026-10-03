/**
 * WhatsApp Cloud API webhook.
 *
 * GET is Meta's one-time subscription handshake (echoes hub.challenge back
 * once hub.verify_token matches WHATSAPP_VERIFY_TOKEN).
 *
 * POST receives every inbound message. Each message's `from` is looked up in
 * whatsappLinks (see src/lib/whatsapp/link.ts) to find which health-tracker
 * account it belongs to — an unlinked number gets a short "link your account
 * first" reply instead of being processed. A linked number's message is
 * either (a) an affirmative reply to an open pendingX proposal on the last
 * assistant message of that user's dedicated WhatsApp chat session — saved
 * directly via src/lib/chat/confirmSave.ts, mirroring what tapping "Confirm"
 * does in the web ChatPanel — or (b) routed through runChatTurn (the same
 * pipeline /api/chat uses) to classify intent and produce a reply, which is
 * then sent back over WhatsApp instead of rendered in a browser.
 *
 * Every inbound WhatsApp message is user-initiated, so a free-form reply
 * (this route never needs an approved message template) always lands within
 * WhatsApp's 24-hour customer-service window.
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";
import { runChatTurn } from "@/lib/chat/runChatTurn";
import { getUidForPhone } from "@/lib/whatsapp/link";
import { sendWhatsAppText, downloadWhatsAppMedia, showTypingIndicator } from "@/lib/whatsapp/client";
import { uploadWhatsAppImage } from "@/lib/whatsapp/media";
import { transcribeAudio } from "@/lib/openai/transcribe";
import { applyPendingActions } from "@/lib/chat/applyActions";
import {
  applyMealActionFromPending,
  saveBodyMetricsFromPending,
  saveMealFromPending,
  saveStepsFromPending,
  saveWorkoutFromPending,
} from "@/lib/chat/confirmSave";
import type { ChatMessage, ChatSession, UserProfile } from "@/lib/types";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && challenge && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

function verifySignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !signatureHeader?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// `\b` is ASCII-only in JS regex — it does NOT mark a boundary after a Hebrew
// letter (Hebrew isn't in \w), so `/^כן\b/` silently never matched a
// standalone "כן" and the reply fell through to being reprocessed as a new
// message instead of confirming. `(?=\s|$)` works for both alphabets.
const AFFIRMATIVE_RE = /^(כן|אשר|תשמור|שמור|אישור|אוקיי|בדיוק|yes|yeah|yep|confirm|save|ok|okay)(?=\s|$)/i;
const THUMBS_UP_RE = /\u{1F44D}/u; // 👍, with or without a skin-tone modifier

/** True for a 👍 emoji reaction on any message, or a text reply that's a thumbs-up or one of AFFIRMATIVE_RE's words — the two ways WhatsApp users can confirm an open proposal (there's no Confirm button like the web chat has). */
function isAffirmativeReply(message: IncomingMessage): boolean {
  if (message.type === "reaction") return !!message.reaction?.emoji && THUMBS_UP_RE.test(message.reaction.emoji);
  const text = message.text?.body?.trim();
  if (!text) return false;
  return THUMBS_UP_RE.test(text) || AFFIRMATIVE_RE.test(text);
}

const CONFIRM_LOOKBACK_MESSAGES = 8;

const CONFIRM_HINT = {
  he: '\n\n👍 (תגובת אמוג׳י) או "כן" כדי לשמור.',
  en: '\n\n👍 (react) or reply "yes" to save.',
} as const;

/** yyyy-mm-dd in the app's home timezone — the server's own UTC "today" can be the wrong day near midnight Israel time, and unlike the web app (which always sends the client's local date) a WhatsApp message carries no timezone info at all. */
function todayInIsrael(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
}

export const maxDuration = 60;

export async function POST(req: Request) {
  const rawBody = await req.text();
  if (!verifySignature(rawBody, req.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: true });
  }

  const message = extractMessage(payload);
  if (!message) {
    // Delivery-status callbacks and other webhook fields carry no `messages` array — nothing to do.
    return NextResponse.json({ ok: true });
  }

  try {
    await handleIncomingMessage(message);
  } catch (err) {
    console.error("[whatsapp] failed to handle incoming message:", err);
    // Every other failure path above replies with something — this is the
    // catch-all for anything that throws (e.g. an upstream API outage),
    // which otherwise left the user staring at a message that silently
    // never gets a reply, with no way to tell whether it was received.
    await sendWhatsAppText(
      message.from,
      "😕 קרתה תקלה וההודעה שלך לא עובדה. נסה שוב בעוד כמה דקות.\n\n😕 Something went wrong and your message wasn't processed. Please try again in a few minutes.",
    ).catch(() => {});
  }
  return NextResponse.json({ ok: true });
}

interface IncomingMessage {
  id: string;
  from: string;
  type: string;
  text?: { body?: string };
  image?: { id?: string; caption?: string };
  audio?: { id?: string; mime_type?: string };
  reaction?: { message_id?: string; emoji?: string };
  context?: { id?: string };
}

function extractMessage(payload: unknown): IncomingMessage | null {
  const entry = (payload as { entry?: unknown[] })?.entry?.[0] as { changes?: unknown[] } | undefined;
  const change = entry?.changes?.[0] as { value?: { messages?: IncomingMessage[] } } | undefined;
  return change?.value?.messages?.[0] ?? null;
}

async function handleIncomingMessage(message: IncomingMessage): Promise<void> {
  // Awaited (not fire-and-forget) since a serverless function can be frozen
  // the moment it returns — an unawaited request here isn't guaranteed to
  // actually complete. The reply itself, once ready, also clears the indicator.
  await showTypingIndicator(message.id);

  const from = message.from;
  const uid = await getUidForPhone(from);
  if (!uid) {
    await sendWhatsAppText(
      from,
      "היי! 👋 המספר הזה עוד לא מקושר לחשבון ב-Health Tracker.\n" +
        "היכנס ל-https://health-tracker-sepia.vercel.app ← פרופיל ← קישור WhatsApp, והזן את המספר הזה כדי לקשר.\n\n" +
        "Hi! 👋 This number isn't linked to a Health Tracker account yet.\n" +
        "Open https://health-tracker-sepia.vercel.app → Profile → Link WhatsApp, and enter this number to link it.",
    );
    return;
  }

  const profileSnap = await adminDb.collection("users").doc(uid).collection("meta").doc("profile").get();
  const lang = ((profileSnap.data() as UserProfile | undefined)?.language ?? "he") as "en" | "he";

  let text = message.text?.body?.trim() || message.image?.caption?.trim() || undefined;
  let imageUrls: string[] | undefined;
  if (message.type === "image" && message.image?.id) {
    try {
      const { buffer, contentType } = await downloadWhatsAppMedia(message.image.id);
      imageUrls = [await uploadWhatsAppImage(uid, buffer, contentType, "whatsapp-images")];
    } catch (err) {
      console.error("[whatsapp] media download failed:", err);
    }
  } else if (message.type === "audio" && message.audio?.id) {
    try {
      const { buffer, contentType } = await downloadWhatsAppMedia(message.audio.id);
      text = await transcribeAudio(buffer, contentType, lang);
    } catch (err) {
      console.error("[whatsapp] audio transcription failed:", err);
      await sendWhatsAppText(
        from,
        lang === "he" ? "לא הצלחתי להבין את ההקלטה — אפשר לכתוב במקום?" : "I couldn't understand that voice note — could you type it instead?",
      );
      return;
    }
    if (!text) {
      await sendWhatsAppText(
        from,
        lang === "he" ? "לא שמעתי כלום בהקלטה — אפשר לנסות שוב?" : "I didn't hear anything in that recording — mind trying again?",
      );
      return;
    }
  }

  const whatsappMetaRef = adminDb.collection("users").doc(uid).collection("meta").doc("whatsapp");
  const sessionId = ((await whatsappMetaRef.get()).data() as { sessionId?: string } | undefined)?.sessionId;

  if (sessionId && isAffirmativeReply(message)) {
    const targetWaId = message.type === "reaction" ? message.reaction?.message_id : message.context?.id;
    const confirmed = await tryConfirmPending(uid, sessionId, lang, from, targetWaId);
    if (confirmed) return;
    if (message.type === "reaction") {
      await sendWhatsAppText(
        from,
        lang === "he"
          ? "אין כרגע הצעה פתוחה לאישור — ייתכן שכבר נשמרה או שעברו כמה הודעות. שלח שוב את מה שרצית לרשום."
          : "There's no open proposal to confirm right now — it may already be saved, or too many messages have passed. Send what you wanted to log again.",
      );
      return;
    }
  }

  if (!text && !imageUrls?.length) return; // unsupported message type (sticker, video, reaction to something else, …) — nothing to act on

  const result = await runChatTurn({
    uid,
    sessionId,
    message: text,
    imageUrls,
    lang,
    date: todayInIsrael(),
    waMessageId: message.id,
    quotedWaId: message.context?.id,
  });
  await whatsappMetaRef.set({ sessionId: result.sessionId }, { merge: true });

  const hasPending = !!(
    result.reply.pendingMeal ||
    result.reply.pendingMealAction ||
    result.reply.pendingActions?.length ||
    result.reply.pendingWorkout ||
    result.reply.pendingSteps ||
    result.reply.pendingBodyMetrics
  );
  const sentId = await sendWhatsAppText(from, hasPending ? `${result.reply.content}${CONFIRM_HINT[lang]}` : result.reply.content);
  if (sentId) await tagLastAssistantMessage(uid, result.sessionId, sentId);
}

/** Records the WhatsApp id of the reply just sent on the session's last (assistant) message, so a later quote-reply or 👍 reaction on it can be matched back. */
async function tagLastAssistantMessage(uid: string, sessionId: string, waId: string): Promise<void> {
  const ref = adminDb.collection("users").doc(uid).collection("chatSessions").doc(sessionId);
  await adminDb.runTransaction(async (tx) => {
    const session = (await tx.get(ref)).data() as ChatSession | undefined;
    const messages = session?.messages;
    if (!messages?.length || messages[messages.length - 1].role !== "assistant") return;
    const updated = [...messages];
    updated[updated.length - 1] = { ...updated[updated.length - 1], waId };
    tx.update(ref, { messages: updated });
  });
}

/** Returns true if the last assistant message in this session had a pendingX that got saved (and a "✅ Saved" reply was sent) — false means there was nothing open to confirm, so the caller should fall through to treating the message as new input. */
async function tryConfirmPending(
  uid: string,
  sessionId: string,
  lang: "en" | "he",
  from: string,
  targetWaId?: string,
): Promise<boolean> {
  const ref = adminDb.collection("users").doc(uid).collection("chatSessions").doc(sessionId);
  const session = (await ref.get()).data() as ChatSession | undefined;
  const hasOpenProposal = (m: ChatMessage) =>
    m.role === "assistant" &&
    !!(m.pendingMeal || m.pendingMealAction || m.pendingActions?.length || m.pendingWorkout || m.pendingSteps || m.pendingBodyMetrics);
  // The user may confirm after a few more messages (e.g. asked a question in between), so look back
  // for the most recent open proposal instead of only checking the very last message.
  let lastIndex = -1;
  const total = session?.messages.length ?? 0;
  // A 👍 or quote-reply aimed at a specific message confirms exactly that one.
  const targetIndex = targetWaId ? (session?.messages.findIndex((m) => m.waId === targetWaId) ?? -1) : -1;
  // An open proposal moves forward into the newest reply, so a 👍 on an older message that no longer holds it falls through to the lookback below.
  if (targetIndex >= 0 && hasOpenProposal(session!.messages[targetIndex])) lastIndex = targetIndex;
  for (let i = total - 1; lastIndex < 0 && i >= Math.max(0, total - CONFIRM_LOOKBACK_MESSAGES); i--) {
    if (hasOpenProposal(session!.messages[i])) {
      lastIndex = i;
      break;
    }
  }
  if (lastIndex < 0) return false;
  const last = session!.messages[lastIndex];

  let mealActionFound = true;
  if (last.pendingMeal) await saveMealFromPending(uid, last.pendingMeal);
  if (last.pendingMealAction) mealActionFound = await applyMealActionFromPending(uid, last.pendingMealAction);
  if (last.pendingWorkout) await saveWorkoutFromPending(uid, last.pendingWorkout);
  if (last.pendingSteps) await saveStepsFromPending(uid, last.pendingSteps);
  if (last.pendingBodyMetrics) await saveBodyMetricsFromPending(uid, last.pendingBodyMetrics);
  let actionsFailed: string[] = [];
  if (last.pendingActions?.length) actionsFailed = (await applyPendingActions(uid, last.pendingActions)).failed;

  const { pendingMeal, pendingMealAction, pendingWorkout, pendingSteps, pendingBodyMetrics, pendingActions, ...rest } = last;
  void pendingActions;
  void pendingMeal;
  void pendingMealAction;
  void pendingWorkout;
  void pendingSteps;
  void pendingBodyMetrics;
  const messages = [...session!.messages];
  messages[lastIndex] = { ...(rest as ChatMessage), confirmedAt: new Date().toISOString() };
  await ref.update({ messages });

  const reply = actionsFailed.length
    ? lang === "he"
      ? `לא הצלחתי לבצע: ${actionsFailed.join(", ")} — ייתכן שזה כבר השתנה.`
      : `Couldn't apply: ${actionsFailed.join(", ")} — it may have already changed.`
    : last.pendingActions?.length && !last.pendingMeal && !last.pendingMealAction && !last.pendingWorkout && !last.pendingSteps && !last.pendingBodyMetrics
      ? lang === "he"
        ? "✅ בוצע"
        : "✅ Done"
      : !mealActionFound
    ? lang === "he"
      ? "לא מצאתי את הרשומה הזו יותר — ייתכן שכבר נמחקה."
      : "That entry no longer exists — it may have already been removed."
    : last.pendingMealAction?.action === "delete"
      ? lang === "he"
        ? "✅ נמחק"
        : "✅ Deleted"
      : last.pendingMealAction
        ? lang === "he"
          ? "✅ עודכן"
          : "✅ Updated"
        : lang === "he"
          ? "✅ נשמר"
          : "✅ Saved";
  await sendWhatsAppText(from, reply);
  return true;
}

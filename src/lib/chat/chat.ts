/**
 * Chat backend logic: intent classification, and the three "answer" paths
 * (log a meal reuses src/lib/nutrition/parser.ts directly rather than
 * forking the estimation logic; query history reads the user's own recent
 * Firestore data; general health is a scoped direct answer). Out-of-scope
 * questions get a canned refusal with no model call — cheaper and more
 * reliable than trusting the model to decline on its own.
 */
import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { getOpenAIClient } from "@/lib/openai/client";
import type { ChatIntent, MealDay, PendingMealAction } from "@/lib/types";

const CHAT_MODEL = "gpt-4o-mini";

const OUT_OF_SCOPE_REPLY: Record<"en" | "he", string> = {
  en: "I can only help with nutrition, fitness, and health questions related to this app — I can't help with that.",
  he: "אני יכול לעזור רק בשאלות תזונה, כושר ובריאות בהקשר של האפליקציה הזו — לא אוכל לעזור בזה.",
};

export function outOfScopeReply(lang: "en" | "he"): string {
  return OUT_OF_SCOPE_REPLY[lang];
}

export async function classifyIntent(message: string): Promise<ChatIntent> {
  const completion = await getOpenAIClient().chat.completions.create({
    model: CHAT_MODEL,
    response_format: { type: "json_object" },
    temperature: 0,
    messages: [
      {
        role: "system",
        content: `Classify the user's message into exactly one intent:
- "log_meal": user is describing food they ate, to be logged.
- "query_history": user is asking about their OWN past logged data (meals, calories, protein, workouts) — trends, totals, comparisons over time.
- "general_health": a nutrition/fitness/health question NOT about their own logged history (meal ideas, menus, general advice, "how much protein should I eat").
- "manage_meal": user wants to delete or correct/edit a meal they ALREADY logged (today, yesterday, or another recent day) — e.g. "delete the peach", "remove the tofu entry", "yesterday's schnitzel was actually 300 calories not 600", "fix my last meal's protein to 30g". This is about an existing logged entry, not describing new food to log.
- "out_of_scope": anything unrelated to nutrition, fitness, or health (coding help, trivia, unrelated small talk, etc).
Respond ONLY as JSON: { "intent": "log_meal" | "query_history" | "general_health" | "manage_meal" | "out_of_scope" }`,
      },
      { role: "user", content: message },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  try {
    const parsed = JSON.parse(raw ?? "{}");
    if (["log_meal", "query_history", "general_health", "manage_meal", "out_of_scope"].includes(parsed.intent)) {
      return parsed.intent as ChatIntent;
    }
  } catch {
    // fall through to fail-closed default below
  }
  return "out_of_scope";
}

/** Bounded window — a personal app doesn't need unbounded history in every prompt. */
const HISTORY_WINDOW_DAYS = 90;

export async function answerHistoryQuery(uid: string, message: string, lang: "en" | "he", today: string): Promise<string> {
  const since = new Date();
  since.setDate(since.getDate() - HISTORY_WINDOW_DAYS);
  const sinceDate = since.toISOString().slice(0, 10);

  const [mealsSnap, workoutsSnap] = await Promise.all([
    adminDb.collection("users").doc(uid).collection("meals").get(),
    adminDb.collection("users").doc(uid).collection("workouts").where("date", ">=", sinceDate).get(),
  ]);

  const meals = mealsSnap.docs
    .map((d) => d.data() as { date: string; totals: unknown })
    .filter((d) => d.date >= sinceDate)
    .map((d) => ({ date: d.date, totals: d.totals }));

  const workouts = workoutsSnap.docs.map((d) => {
    const w = d.data() as { date: string; type: string; duration: number; calories?: number; distance?: number };
    return { date: w.date, type: w.type, durationSec: w.duration, calories: w.calories, distanceMeters: w.distance };
  });

  const completion = await getOpenAIClient().chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      {
        role: "system",
        content: `Today's date is ${today} (yyyy-mm-dd) — use it to resolve relative date references in the question ("yesterday", "last week", "this weekend", etc.) against the ISO dates in the data below; do not guess what day it is. You answer questions about the user's own logged nutrition/workout history using ONLY the JSON data provided — never invent numbers. Respond in ${lang === "he" ? "Hebrew" : "English"}, plain conversational language, concise. If the question needs data outside the last ${HISTORY_WINDOW_DAYS} days, say so honestly instead of guessing. Plain text only — no markdown (no **bold**, no #headers, no markdown list syntax); this is rendered in a plain chat bubble.`,
      },
      { role: "user", content: `Data (last ${HISTORY_WINDOW_DAYS} days):\n${JSON.stringify({ meals, workouts })}\n\nQuestion: ${message}` },
    ],
  });

  return completion.choices[0]?.message?.content ?? "";
}

export async function answerGeneralHealth(message: string, lang: "en" | "he"): Promise<string> {
  const completion = await getOpenAIClient().chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      {
        role: "system",
        content: `You are a helpful nutrition and fitness assistant inside a personal health-tracking app. Answer questions about nutrition, meal planning, menus, workouts, and general health practically and concisely. If a question drifts outside those topics, politely decline and redirect to health topics. Respond in ${lang === "he" ? "Hebrew" : "English"}. Plain text only — no markdown (no **bold**, no #headers, no markdown bullet/numbered list syntax); this is rendered in a plain chat bubble, not a markdown renderer. For lists, write "1) ... 2) ..." with each item on its own line, separated by a blank line, for readability.`,
      },
      { role: "user", content: message },
    ],
  });
  return completion.choices[0]?.message?.content ?? "";
}

/** How far back "manage_meal" looks for an entry to edit/delete — covers "yesterday" and casual same-week corrections without scanning the whole history. */
const MANAGE_MEAL_WINDOW_DAYS = 14;

/**
 * Resolves a "manage_meal" message (delete/edit an already-logged meal)
 * against recent entries — not just today's, since users reasonably say
 * "yesterday's schnitzel was 300 calories, not 600". Returns a
 * pendingMealAction for the client to confirm — never mutates Firestore
 * directly, so a misread ("delete the peach" matching the wrong row) can't
 * destroy data without a confirm click, same posture as pendingMeal for new
 * logs.
 */
export async function resolveMealAction(
  uid: string,
  today: string,
  message: string,
  lang: "en" | "he",
): Promise<{ replyContent: string; pendingMealAction?: PendingMealAction }> {
  const since = new Date(today);
  since.setDate(since.getDate() - MANAGE_MEAL_WINDOW_DAYS);
  const sinceDate = since.toISOString().slice(0, 10);

  const snap = await adminDb
    .collection("users")
    .doc(uid)
    .collection("meals")
    .where("date", ">=", sinceDate)
    .where("date", "<=", today)
    .get();

  const entries = snap.docs.flatMap((d) => {
    const day = d.data() as MealDay;
    return day.entries.map((e) => ({ ...e, date: day.date }));
  });

  if (entries.length === 0) {
    return {
      replyContent:
        lang === "he" ? "לא נמצאו ארוחות רשומות בטווח הזמן האחרון." : "There are no recently logged meals to change.",
    };
  }

  const completion = await getOpenAIClient().chat.completions.create({
    model: CHAT_MODEL,
    response_format: { type: "json_object" },
    temperature: 0,
    messages: [
      {
        role: "system",
        content: `The user wants to delete or edit one of their already-logged meals. Today's date is ${today} (yyyy-mm-dd) — use it to resolve relative date references ("yesterday", "on Monday", etc.) in their message. Here are their logged entries from the last ${MANAGE_MEAL_WINDOW_DAYS} days as JSON, each tagged with the date it was logged on:
${JSON.stringify(entries.map((e) => ({ id: e.id, date: e.date, name: e.name, calories: e.calories, protein: e.protein, carbs: e.carbs, fat: e.fat, fiber: e.fiber })))}

Match the user's message to exactly one entry by date and name/description. The user is typing on a
phone and may misspell, mistype, or use an inconsistent transliteration of the food name (e.g.
"vegeteriane shnitzel", "shnitzel", "veg schnitzel" should all match an entry named "Vegetarian
schnitzel" — treat these as the same food; don't require an exact or near-exact string match).
Judge by what food it most plausibly refers to, not by spelling distance. Respond ONLY as JSON:
{ "found": boolean, "action": "delete" | "update", "entryId": string, "date": string, "changes": { "name"?: string, "calories"?: number, "protein"?: number, "carbs"?: number, "fat"?: number, "fiber"?: number }, "summary": string }
- "date": the date (yyyy-mm-dd) of the matched entry, from its "date" field above.
- If action is "update", only include the fields in "changes" that the user actually wants changed.
- "summary": a short one-sentence description of what you're about to do, in ${lang === "he" ? "Hebrew" : "English"}, plain text, no markdown, ending with a question asking the user to confirm.
- Only set "found": false if the food genuinely doesn't match anything in the list (not because of
  spelling/typos) or if it's genuinely ambiguous between two or more distinct foods on the SAME
  date — in that case, "summary" should explain that in ${lang === "he" ? "Hebrew" : "English"}.`,
      },
      { role: "user", content: message },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  let parsed: {
    found?: boolean;
    action?: "delete" | "update";
    entryId?: string;
    date?: string;
    changes?: PendingMealAction["changes"];
    summary?: string;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { found: false };
  }

  const target = entries.find((e) => e.id === parsed.entryId);
  if (!parsed.found || !target || (parsed.action !== "delete" && parsed.action !== "update")) {
    return {
      replyContent:
        parsed.summary ?? (lang === "he" ? "לא הצלחתי לזהות איזו ארוחה התכוונת אליה." : "I couldn't tell which meal you meant."),
    };
  }

  return {
    replyContent: parsed.summary ?? (lang === "he" ? "לאשר?" : "Confirm?"),
    pendingMealAction: {
      action: parsed.action,
      date: target.date,
      entryId: target.id,
      entryName: target.name,
      ...(parsed.action === "update" && parsed.changes ? { changes: parsed.changes } : {}),
    },
  };
}

export async function generateSessionTitle(firstUserMessage: string, firstAssistantReply: string): Promise<string> {
  const completion = await getOpenAIClient().chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.3,
    messages: [
      { role: "system", content: "Summarize this chat exchange into a short 3-6 word title. No punctuation at the end, no quotes." },
      { role: "user", content: `User: ${firstUserMessage}\nAssistant: ${firstAssistantReply}` },
    ],
  });
  return (completion.choices[0]?.message?.content ?? "Chat").trim();
}

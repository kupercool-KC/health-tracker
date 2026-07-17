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
import type { ChatIntent } from "@/lib/types";

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
- "out_of_scope": anything unrelated to nutrition, fitness, or health (coding help, trivia, unrelated small talk, etc).
Respond ONLY as JSON: { "intent": "log_meal" | "query_history" | "general_health" | "out_of_scope" }`,
      },
      { role: "user", content: message },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  try {
    const parsed = JSON.parse(raw ?? "{}");
    if (["log_meal", "query_history", "general_health", "out_of_scope"].includes(parsed.intent)) {
      return parsed.intent as ChatIntent;
    }
  } catch {
    // fall through to fail-closed default below
  }
  return "out_of_scope";
}

/** Bounded window — a personal app doesn't need unbounded history in every prompt. */
const HISTORY_WINDOW_DAYS = 90;

export async function answerHistoryQuery(uid: string, message: string, lang: "en" | "he"): Promise<string> {
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
        content: `You answer questions about the user's own logged nutrition/workout history using ONLY the JSON data provided — never invent numbers. Respond in ${lang === "he" ? "Hebrew" : "English"}, plain conversational language, concise. If the question needs data outside the last ${HISTORY_WINDOW_DAYS} days, say so honestly instead of guessing.`,
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
        content: `You are a helpful nutrition and fitness assistant inside a personal health-tracking app. Answer questions about nutrition, meal planning, menus, workouts, and general health practically and concisely. If a question drifts outside those topics, politely decline and redirect to health topics. Respond in ${lang === "he" ? "Hebrew" : "English"}.`,
      },
      { role: "user", content: message },
    ],
  });
  return completion.choices[0]?.message?.content ?? "";
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

/**
 * Chat backend logic: intent classification, and the three "answer" paths
 * (log a meal reuses src/lib/nutrition/parser.ts directly rather than
 * forking the estimation logic; query history reads the user's own recent
 * Firestore data; general health is a scoped direct answer). Out-of-scope
 * questions get a canned refusal with no model call — cheaper and more
 * reliable than trusting the model to decline on its own.
 */
import "server-only";
import type OpenAI from "openai";
import { adminDb } from "@/lib/firebase/admin";
import { getOpenAIClient } from "@/lib/openai/client";
import { computeNetCalories, DEFAULT_NET_CALORIE_BURN_FACTOR } from "@/lib/goals/netCalories";
import { lookupUsdaNutrients, webSearchNutrition } from "@/lib/nutrition/usda";
import { strings } from "@/lib/i18n/strings";
import type { ChatIntent, ChatMessage, MealDay, PendingMealAction, UserProfile } from "@/lib/types";

/**
 * The model is repeatedly told to reply in plain text (this renders in a
 * chat bubble, not a markdown viewer) but doesn't always comply — belt and
 * suspenders: strip the common markdown markers it occasionally leaves in
 * literally (e.g. "**249 calories**" showing its asterisks) rather than
 * relying on the instruction alone.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^[-*]\s+/gm, "");
}

/**
 * How many prior turns of conversation to give the classifier/advice model
 * as context — enough to resolve "check for this one" or a one-word answer
 * to the assistant's own follow-up question, without ballooning every call
 * with the whole session history.
 */
const HISTORY_CONTEXT_TURNS = 8;

function toContextMessages(history: ChatMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return history.slice(-HISTORY_CONTEXT_TURNS).map((m) => ({ role: m.role, content: m.content }));
}

const CHAT_MODEL = "gpt-4o-mini";

const OUT_OF_SCOPE_REPLY: Record<"en" | "he", string> = {
  en: "I can only help with nutrition, fitness, and health questions related to this app — I can't help with that.",
  he: "אני יכול לעזור רק בשאלות תזונה, כושר ובריאות בהקשר של האפליקציה הזו — לא אוכל לעזור בזה.",
};

export function outOfScopeReply(lang: "en" | "he"): string {
  return OUT_OF_SCOPE_REPLY[lang];
}

/**
 * A bare "hi"/"שלום" was landing on the hard out_of_scope refusal — technically
 * correct (a greeting isn't a nutrition/fitness question) but reads as
 * needlessly blunt for the very first thing a lot of users type. Handled as
 * its own fast path (skips the classifier entirely) rather than folding it
 * into "general_health", so it stays a fixed, free, zero-latency reply
 * instead of a model call.
 */
const GREETING_REGEX = /^(hi+|hello+|hey+|yo|sup|shalom|שלום|היי+|הי|אהלן|מה נשמע)[!.\s]*$/i;

export function isGreeting(message: string): boolean {
  return GREETING_REGEX.test(message.trim());
}

const GREETING_REPLY: Record<"en" | "he", string> = {
  en: "Hi! I can log meals or workouts (just describe them or send a photo), answer nutrition/fitness questions, or look up your history. What would you like to do?",
  he: "היי! אני יכול לתעד ארוחות או אימונים (רק תכתוב או תשלח תמונה), לענות על שאלות תזונה וכושר, או לחפש בהיסטוריה שלך. במה אפשר לעזור?",
};

export function greetingReply(lang: "en" | "he"): string {
  return GREETING_REPLY[lang];
}

/**
 * A log_meal/log_workout/log_steps message that turns out to have nothing
 * extractable (e.g. "add it" with no food named anywhere nearby, or the
 * model returning something that fails schema validation) previously threw
 * all the way out to the route's generic catch-all 500 — surfaced to the
 * user as a bare "Internal error" with no way to recover except retyping
 * from scratch. This gives them a next step instead of a dead end.
 */
const PARSE_FAILURE_REPLY: Record<"en" | "he", string> = {
  en: "I couldn't figure out what to log from that — could you describe the food/workout and amount again?",
  he: "לא הצלחתי להבין מה לתעד מזה — אפשר לתאר שוב את המאכל/האימון והכמות?",
};

export function parseFailureReply(lang: "en" | "he"): string {
  return PARSE_FAILURE_REPLY[lang];
}

const INTENTS: ChatIntent[] = [
  "log_meal",
  "log_workout",
  "log_steps",
  "query_history",
  "general_health",
  "manage_meal",
  "out_of_scope",
];

export async function classifyIntent(message: string, history: ChatMessage[] = []): Promise<ChatIntent> {
  const completion = await getOpenAIClient().chat.completions.create({
    model: CHAT_MODEL,
    response_format: { type: "json_object" },
    temperature: 0,
    messages: [
      {
        role: "system",
        content: `Classify the user's LATEST message into exactly one intent. Recent conversation turns are included for context — the latest message is very often a short follow-up (a one-word answer to a question you just asked, "check this one" referring to a photo sent a few messages back, a product name given after being asked to clarify) rather than a complete standalone sentence. Read it in light of what was just discussed before classifying.
- "log_meal": user is describing food they ate, to be logged (for today OR any other day — "add 2 eggs for yesterday" is still log_meal, not manage_meal).
- "log_workout": user is describing a workout/exercise session to be logged (running, gym, swimming, etc.), for today or any other day.
- "log_steps": user is reporting a step count to be logged, for today or any other day (e.g. "I walked 8500 steps yesterday", "log 10k steps for Monday").
- "query_history": user is asking about their OWN past logged data (meals, calories, protein, workouts, steps) — trends, totals, comparisons over time.
- "general_health": a nutrition/fitness/health question NOT about their own logged history. Read this broadly — meal ideas, menus, general advice, building a workout plan/program, comparing foods' calories, "how much protein should I eat", sleep, hydration, supplements, recovery, injuries, energy levels, weight management, body composition, motivation/habits around eating or exercise, or answering the assistant's own request for a food/drink/product name so it can answer a question from earlier in the conversation. When a question is adjacent to health/fitness/nutrition or could reasonably be interpreted that way, classify it here rather than out_of_scope. IMPORTANT for a bare photo with no caption text: if you had just asked a general nutrition/comparison question and requested a photo to answer it (e.g. "send me a photo of the menu/dish"), a photo sent right after that is continuing THAT question — classify it general_health, not log_meal, even with zero caption text. Only classify a captionless photo as log_meal when nothing in the recent conversation suggests it's answering an open question — i.e. it's a fresh "here's what I ate" upload.
- "manage_meal": user wants to delete or correct/edit a meal they ALREADY logged (today, yesterday, or another recent day) — e.g. "delete the peach", "remove the tofu entry", "yesterday's schnitzel was actually 300 calories not 600", "fix my last meal's protein to 30g". This is about an existing logged entry, not describing new food to log.
- "out_of_scope": ONLY for messages with genuinely no plausible nutrition/fitness/health angle, even accounting for the conversation so far (coding help, trivia, unrelated small talk, world news, etc). Give the benefit of the doubt: a short, oddly-phrased, or terse message that plausibly continues the current topic (e.g. it names a food/product/brand right after the assistant asked "which drink?"), or a question that's tangential but still health-adjacent, is NOT out_of_scope. When genuinely torn between general_health and out_of_scope, pick general_health — a wrong refusal is a worse outcome than answering something borderline.
Respond ONLY as JSON: { "intent": "log_meal" | "log_workout" | "log_steps" | "query_history" | "general_health" | "manage_meal" | "out_of_scope" }`,
      },
      ...toContextMessages(history),
      { role: "user", content: message },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  try {
    const parsed = JSON.parse(raw ?? "{}");
    if (INTENTS.includes(parsed.intent)) {
      return parsed.intent as ChatIntent;
    }
  } catch {
    // fall through to fail-closed default below
  }
  return "out_of_scope";
}

/**
 * Resolves which day a log_meal/log_workout/log_steps message applies to —
 * "add this for yesterday", "log 3 days ago", "on Monday" — defaulting to
 * `today` when no date is mentioned. A dedicated cheap call rather than
 * folding this into the nutrition/workout/steps parsers, which reason about
 * the content (calories, duration, etc.), not calendar phrases.
 */
export async function resolveLogDate(message: string, today: string): Promise<string> {
  const completion = await getOpenAIClient().chat.completions.create({
    model: CHAT_MODEL,
    response_format: { type: "json_object" },
    temperature: 0,
    messages: [
      {
        role: "system",
        content: `Today's date is ${today} (yyyy-mm-dd). The user is logging something (a meal, workout, or step count) and may mention which day it's for — "yesterday", "3 days ago", "on Monday", "last Tuesday" — or may not mention a day at all, which means today. Resolve their message to a single date. Respond ONLY as JSON: { "date": "yyyy-mm-dd" }. Never return a date in the future.`,
      },
      { role: "user", content: message },
    ],
  });
  const raw = completion.choices[0]?.message?.content ?? "{}";
  try {
    const parsed = JSON.parse(raw) as { date?: string };
    if (parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) && parsed.date <= today) {
      return parsed.date;
    }
  } catch {
    // fall through to default below
  }
  return today;
}

/** Bounded window — a personal app doesn't need unbounded history in every prompt. */
const HISTORY_WINDOW_DAYS = 90;
/** Window for general_health's "personalize using recent activity" context — 3 months, same as the deep-history path, so a nutrition-advice question can reference anything recent enough to still be relevant. */
const RECENT_CONTEXT_WINDOW_DAYS = 90;

interface RecentHistoryData {
  meals: { date: string; totals: MealDay["totals"]; burnedCalories: number; netCalories: number }[];
  workouts: { date: string; type: string; durationSec: number; calories?: number; distanceMeters?: number }[];
  steps: { date: string; steps: number }[];
  calorieGoal?: number;
  netCalorieBurnFactor: number;
}

/**
 * Reads the user's own logged meals/workouts/steps (plus the profile
 * fields needed to compute net calories) from Firestore — shared by
 * answerHistoryQuery (deep "how did I do last month" questions) and
 * answerGeneralHealth (so a generic nutrition/fitness question can factor
 * in what's actually been logged instead of only static profile fields).
 */
async function fetchRecentHistory(uid: string, windowDays: number): Promise<RecentHistoryData> {
  const since = new Date();
  since.setDate(since.getDate() - windowDays);
  const sinceDate = since.toISOString().slice(0, 10);

  const [mealsSnap, workoutsSnap, stepsSnap, profileSnap] = await Promise.all([
    adminDb.collection("users").doc(uid).collection("meals").where("date", ">=", sinceDate).get(),
    adminDb.collection("users").doc(uid).collection("workouts").where("date", ">=", sinceDate).get(),
    adminDb.collection("users").doc(uid).collection("steps").where("date", ">=", sinceDate).get(),
    adminDb.collection("users").doc(uid).collection("meta").doc("profile").get(),
  ]);

  const profile = profileSnap.data() as UserProfile | undefined;
  const netCalorieBurnFactor = profile?.netCalorieBurnFactor ?? DEFAULT_NET_CALORIE_BURN_FACTOR;

  const meals = mealsSnap.docs.map((d) => d.data() as { date: string; totals: MealDay["totals"] });
  const workouts = workoutsSnap.docs.map((d) => {
    const w = d.data() as { date: string; type: string; duration: number; calories?: number; distance?: number };
    return { date: w.date, type: w.type, durationSec: w.duration, calories: w.calories, distanceMeters: w.distance };
  });
  const steps = stepsSnap.docs.map((d) => {
    const s = d.data() as { date: string; steps: number };
    return { date: s.date, steps: s.steps };
  });

  const burnedByDate = new Map<string, number>();
  for (const w of workouts) {
    burnedByDate.set(w.date, (burnedByDate.get(w.date) ?? 0) + (w.calories ?? 0));
  }

  // netCalories per day is precomputed here (not left to the model) so the
  // deficit/surplus math is exact rather than something an LLM might get
  // wrong when asked to apply the formula itself.
  const mealsWithNet = meals.map((m) => {
    const burned = burnedByDate.get(m.date) ?? 0;
    const calories = m.totals.calories ?? 0;
    return {
      date: m.date,
      totals: m.totals,
      burnedCalories: burned,
      netCalories: Math.round(computeNetCalories(calories, burned, netCalorieBurnFactor)),
    };
  });

  return { meals: mealsWithNet, workouts, steps, calorieGoal: profile?.calorieGoal, netCalorieBurnFactor };
}

export async function answerHistoryQuery(uid: string, message: string, lang: "en" | "he", today: string): Promise<string> {
  const { meals, workouts, steps, calorieGoal, netCalorieBurnFactor } = await fetchRecentHistory(uid, HISTORY_WINDOW_DAYS);

  const completion = await getOpenAIClient().chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      {
        role: "system",
        content: `Today's date is ${today} (yyyy-mm-dd) — use it to resolve relative date references in the question ("yesterday", "last week", "this weekend", etc.) against the ISO dates in the data below; do not guess what day it is. You answer questions about the user's own logged nutrition/workout/step history using ONLY the JSON data provided — never invent numbers. Respond in ${lang === "he" ? "Hebrew" : "English"}, plain conversational language, concise. If the question needs data outside the last ${HISTORY_WINDOW_DAYS} days, say so honestly instead of guessing. Plain text only — no markdown (no **bold**, no #headers, no markdown list syntax); this is rendered in a plain chat bubble.

Each entry in "meals" already includes "netCalories" — the day's net calorie balance, computed as consumed calories minus (burned calories × ${netCalorieBurnFactor}%), i.e. only ${netCalorieBurnFactor}% of a workout's burned calories count toward the deficit (this is the user's configured factor, meant to keep the deficit conservative since burn estimates run optimistic). When asked about deficit/surplus/"net calories"/"caloric balance", use "netCalories" directly rather than recomputing it, and compare it against the calorie goal${calorieGoal != null ? ` (${calorieGoal} kcal/day)` : ""} — under or at goal is a deficit, over goal is a surplus.`,
      },
      {
        role: "user",
        content: `Data (last ${HISTORY_WINDOW_DAYS} days):\n${JSON.stringify({ meals, workouts, steps })}\n\nQuestion: ${message}`,
      },
    ],
  });

  return stripMarkdown(completion.choices[0]?.message?.content ?? "");
}

/**
 * Lets answerGeneralHealth ground any specific calorie/protein number it
 * states in USDA's database instead of its own (occasionally wrong) memory
 * — the same class of hallucination fixed for meal logging in
 * src/lib/nutrition/usda.ts, now available on the advice path too.
 */
const NUTRITION_LOOKUP_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "lookup_food_nutrition",
    description:
      "Look up verified calories and protein per 100g for a specific food from the USDA FoodData Central database. " +
      "Call this whenever you're about to state a specific calorie or protein number for a named food, instead of " +
      "relying on your own memory — USDA is authoritative and your memory sometimes isn't. Returns null if no " +
      "reliable match is found — in that case, still answer using your own best estimate (clearly labeled as an " +
      "estimate); never refuse to answer or leave the question unanswered just because this lookup came back empty.",
    parameters: {
      type: "object",
      properties: {
        food: {
          type: "string",
          description:
            "A specific, internationally-recognized English food name, qualified with its preparation/state " +
            "(e.g. \"white rice, cooked\" not just \"rice\"; \"chicken breast, grilled\" not just \"chicken\").",
        },
      },
      required: ["food"],
    },
  },
};

const MAX_TOOL_ROUNDS = 4;

/** Compact one-line summary of the fields most relevant to fitness/nutrition advice — omits anything unset rather than showing "age: unknown". */
export function summarizeProfileForChat(profile: Partial<UserProfile> | undefined): string | null {
  if (!profile) return null;
  const parts: string[] = [];
  if (profile.age != null) parts.push(`age ${profile.age}`);
  if (profile.gender) parts.push(profile.gender);
  if (profile.weight != null) parts.push(`${profile.weight}kg`);
  if (profile.height != null) parts.push(`${profile.height}cm`);
  if (profile.activityLevel) parts.push(`activity level: ${profile.activityLevel}`);
  if (profile.goals?.length) parts.push(`goal(s): ${profile.goals.join(", ")}`);
  if (profile.workoutTypes?.length) parts.push(`does: ${profile.workoutTypes.join(", ")}`);
  if (profile.dietaryPrefs?.length) parts.push(`diet: ${profile.dietaryPrefs.join(", ")}`);
  if (profile.allergies?.length) parts.push(`allergies: ${profile.allergies.join(", ")}`);
  if (profile.avoidFoods?.length) parts.push(`avoids: ${profile.avoidFoods.join(", ")}`);
  if (profile.calorieGoal != null) parts.push(`calorie goal ${profile.calorieGoal}/day`);
  if (profile.proteinGoal != null) parts.push(`protein goal ${profile.proteinGoal}g/day`);
  if (profile.stepGoal != null) parts.push(`step goal ${profile.stepGoal}/day`);
  return parts.length > 0 ? parts.join(", ") : null;
}

export async function answerGeneralHealth(
  uid: string,
  message: string,
  lang: "en" | "he",
  today: string,
  history: ChatMessage[] = [],
  imageUrl?: string,
  profileSummary?: string | null,
): Promise<string> {
  const { meals, workouts, steps } = await fetchRecentHistory(uid, RECENT_CONTEXT_WINDOW_DAYS);
  const recentActivityJson = meals.length || workouts.length || steps.length ? JSON.stringify({ meals, workouts, steps }) : null;

  const systemMessage: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
    role: "system",
    content: `You are a helpful nutrition and fitness assistant inside a personal health-tracking app. Today's date is ${today} (yyyy-mm-dd) — use it to resolve any relative date reference in the question and tailor advice to that day (e.g. day of week, time of year) when relevant. You can:
- Build workout plans/programs (e.g. a weekly split, a running progression, warm-up/cool-down structure).
- Give detailed, practical advice comparing foods, meals, or menus by calories/macros, and general nutrition guidance.
- Answer general fitness/health questions.
${profileSummary ? `This user's own profile: ${profileSummary}. Use it to personalize your answer whenever it's relevant (e.g. calorie-burn estimates depend heavily on body weight and intensity — use their actual weight/activity level instead of a generic range; respect their allergies/avoided foods/dietary prefs in any suggestion) — don't ask them to repeat information you already have here.\n` : ""}${recentActivityJson ? `This user's own logged meals/workouts/steps from the last ${RECENT_CONTEXT_WINDOW_DAYS} days (JSON, date-keyed): ${recentActivityJson}. Use this real data whenever the question calls for it — "have I eaten enough protein today", "should I do a workout today", "how am I doing this week" — instead of answering in the abstract. This is a light dataset for personalizing general advice, not exhaustive history; for a deep/long-range question about their history, that's handled by a different, more thorough path, so don't claim certainty about data outside this window.\n` : ""}Recent conversation turns are included for context — the user's latest message may be a short follow-up (a product/brand name given after you asked "which drink?", "check this one" referring to a photo sent earlier) rather than a complete standalone question. Use that context to figure out what's actually being asked instead of asking the user to repeat themselves, unless it's genuinely still unclear.
A message may include a photo — a menu, an ingredient list, a nutrition label, a product package. Read what's actually written/shown in it (a dish name, its listed ingredients) and use THAT as the basis for your lookup_food_nutrition call; don't answer about a different, more "typical" dish than what's actually pictured. A restaurant menu entry usually lists ingredients but never calories — that's expected, not a reason to guess a generic substitute; look up the specific named dish (or, if it's not a standalone well-known dish, estimate from its listed ingredients and their typical portions) and say plainly when you're estimating rather than presenting a made-up number as fact.
Use the lookup_food_nutrition tool to verify any specific calorie/protein number you state for a named food — don't state a specific number from memory alone. The tool always returns values per 100g. Most real questions aren't phrased per 100g ("how many calories in a date", "in a slice of bread", "in a cup of rice") — when that's the case, use your own knowledge of a typical weight for that unit (one date ≈ 8g, one slice of bread ≈ 30g, a cup of cooked rice ≈ 158g, etc.) to convert the per-100g figure into a direct answer for the actual unit asked about. Always give that concrete converted number — mentioning the per-100g figure along the way is fine, but never stop at "it's X per 100g" and leave the original question unanswered.
If you genuinely can't identify the specific food being asked about (image too unclear, dish name not resolvable to anything, no ingredient info at all) say so plainly instead of inventing an answer about a different, unrelated food — a wrong confident number is worse than an honest "I can't tell from this."
If a question drifts outside nutrition/fitness/health entirely, politely decline and redirect to those topics. Respond in ${lang === "he" ? "Hebrew" : "English"}. Plain text only — no markdown (no **bold**, no #headers, no markdown bullet/numbered list syntax); this is rendered in a plain chat bubble, not a markdown renderer. For lists, write "1) ... 2) ..." with each item on its own line, separated by a blank line, for readability.`,
  };

  const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: "text", text: message }];
  if (imageUrl) userContent.push({ type: "image_url", image_url: { url: imageUrl } });

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    systemMessage,
    ...toContextMessages(history),
    { role: "user", content: userContent },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const completion = await getOpenAIClient().chat.completions.create({
      model: CHAT_MODEL,
      messages,
      tools: [NUTRITION_LOOKUP_TOOL],
    });

    const choice = completion.choices[0]?.message;
    if (!choice) return "";

    const toolCalls = choice.tool_calls?.filter((c) => c.type === "function");
    if (!toolCalls || toolCalls.length === 0) {
      return stripMarkdown(choice.content ?? "");
    }

    messages.push(choice);
    for (const call of toolCalls) {
      let food = "";
      try {
        food = JSON.parse(call.function.arguments).food ?? "";
      } catch {
        // malformed arguments — fall through with an empty query, which lookupUsdaNutrients handles as "no match"
      }
      // USDA's own datasets skew US-centric and miss plenty of regional/branded
      // foods entirely (not a wrong match — no candidates at all). Try a web
      // search before giving up and letting the model fall back to its own
      // unverified memory.
      const match = food ? (await lookupUsdaNutrients(food)) ?? (await webSearchNutrition(food)) : null;
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(match ?? { error: "No reliable match found for this food, from USDA or the web." }),
      });
    }
  }

  // Ran out of tool-call rounds (unusual) — ask once more without tools so the model must answer directly.
  const finalCompletion = await getOpenAIClient().chat.completions.create({ model: CHAT_MODEL, messages });
  return stripMarkdown(finalCompletion.choices[0]?.message?.content ?? "");
}

export interface PendingMealFollowUpResult {
  kind: "correction" | "question" | "new";
  replyContent?: string;
  pendingMeal?: ChatMessage["pendingMeal"];
}

/**
 * Determines whether the user's latest message is reacting to an already
 * open (unconfirmed) pendingMeal proposal — correcting its numbers, or
 * asking about them — rather than describing a new food to log. Called
 * BEFORE the normal intent classifier whenever the previous assistant
 * message carried a pendingMeal; if this returns "new", the caller falls
 * through to the regular log_meal/general_health/etc. flow untouched.
 */
export async function resolvePendingMealFollowUp(
  message: string,
  openPendingMeal: NonNullable<ChatMessage["pendingMeal"]>,
  lang: "en" | "he",
  history: ChatMessage[],
): Promise<PendingMealFollowUpResult> {
  const completion = await getOpenAIClient().chat.completions.create({
    model: CHAT_MODEL,
    response_format: { type: "json_object" },
    temperature: 0,
    messages: [
      {
        role: "system",
        content: `The assistant just proposed logging this meal, not yet saved: ${JSON.stringify(openPendingMeal.items)}. Classify the user's LATEST message as exactly one of:
- "correction": they're stating the calories/protein should be a specific different value (e.g. "no, it's 249", "protein should be 30g", "make it 300 calories").
- "question": they're asking about the numbers/estimate (e.g. "why 468 calories?", "how did you get that?", "where does that come from?") without providing a new value.
- "new": anything else — describing a different food to log, confirming as-is, or unrelated.
Respond ONLY as JSON: { "kind": "correction"|"question"|"new", "calories"?: number, "protein"?: number, "explanation"?: string }
For "correction": include whichever of calories/protein the user specified (omit the other if only one was mentioned).
For "question": include a concise "explanation" answering what they asked about the estimate — if you genuinely don't know why a specific number was produced, say that plainly instead of inventing a justification. Write "explanation" in ${lang === "he" ? "Hebrew" : "English"}.`,
      },
      ...toContextMessages(history),
      { role: "user", content: message },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  let parsed: { kind?: string; calories?: number; protein?: number; explanation?: string };
  try {
    parsed = JSON.parse(raw ?? "{}");
  } catch {
    return { kind: "new" };
  }

  if (parsed.kind === "correction" && (parsed.calories != null || parsed.protein != null)) {
    if (openPendingMeal.items.length !== 1) {
      // Can't unambiguously map one stated total to a specific item in a multi-item proposal.
      return {
        kind: "question",
        replyContent:
          lang === "he" ? "יש כאן כמה פריטים — איזה מהם צריך לתקן?" : "There are multiple items here — which one should I correct?",
      };
    }
    const [item] = openPendingMeal.items;
    const updatedItem = {
      ...item,
      ...(parsed.calories != null ? { calories: parsed.calories } : {}),
      ...(parsed.protein != null ? { protein: parsed.protein } : {}),
    };
    const updatedPendingMeal = { ...openPendingMeal, items: [updatedItem] };
    const summary = `${updatedItem.description}: ${Math.round(updatedItem.calories)} kcal, ${Math.round(updatedItem.protein)}${strings.unitG[lang]} ${strings.protein[lang]}`;
    return {
      kind: "correction",
      pendingMeal: updatedPendingMeal,
      replyContent: `${summary}\n` + (lang === "he" ? "לאשר ולשמור?" : "Confirm to save it?"),
    };
  }

  if (parsed.kind === "question") {
    return {
      kind: "question",
      replyContent: stripMarkdown(
        parsed.explanation || (lang === "he" ? "אין לי הסבר נוסף לתת כרגע." : "I don't have a further explanation to give right now."),
      ),
    };
  }

  return { kind: "new" };
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

export async function generateSessionTitle(
  firstUserMessage: string,
  firstAssistantReply: string,
  lang: "en" | "he",
): Promise<string> {
  const completion = await getOpenAIClient().chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content: `Summarize this chat exchange into a short 3-6 word title, in ${lang === "he" ? "Hebrew" : "English"} regardless of what language the exchange itself is in. No punctuation at the end, no quotes.`,
      },
      { role: "user", content: `User: ${firstUserMessage}\nAssistant: ${firstAssistantReply}` },
    ],
  });
  return (completion.choices[0]?.message?.content ?? (lang === "he" ? "שיחה" : "Chat")).trim();
}

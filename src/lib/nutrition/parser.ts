/**
 * Nutrition parsing: turn a chat message and/or a food image into structured
 * { description, calories, protein }. Server-only — uses the OpenAI key.
 *
 * The provider lives behind the `parseNutrition` function so it can be swapped
 * later without touching the API routes. System prompt / model / sampling
 * params are editable at runtime from /admin (see ./config.ts) instead of
 * hardcoded here.
 */
import "server-only";
import type OpenAI from "openai";
import { z } from "zod";
import type { ParsedNutrition } from "@/lib/types";
import { getNutritionParserConfig } from "./config";
import { getOpenAIClient } from "@/lib/openai/client";
import { lookupUsdaNutrients, webSearchNutrition } from "./usda";

// estimatedGrams/explicitCalories/explicitProtein are internal to this
// module (used for USDA grounding below) and stripped before returning —
// ParsedNutritionItem only exposes the final "grams" field.
const itemSchema = z.object({
  description: z.string().min(1),
  calories: z.number().nonnegative(),
  protein: z.number().nonnegative(),
  carbs: z.number().nonnegative().optional(),
  fat: z.number().nonnegative().optional(),
  fiber: z.number().nonnegative().optional(),
  confidence: z.number().min(0).max(1).optional(),
  estimatedGrams: z.number().nonnegative().optional(),
  explicitCalories: z.boolean().optional(),
  explicitProtein: z.boolean().optional(),
  usdaSearchTerm: z.string().optional(),
  // The model doesn't always follow "array of strings" when there's only
  // one ingredient to list — it sometimes returns a bare string instead
  // (e.g. "yellow curry" instead of ["yellow curry"]), which used to fail
  // schema validation outright and crash the whole log with an opaque
  // Zod error. Coerce a single string into a 1-element array rather than
  // rejecting it.
  ingredients: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (typeof v === "string" ? [v] : v)),
});
const parsedSchema = z.object({ items: z.array(itemSchema).min(1) });

export interface ParseInput {
  /** Free-text message from the chat box. Optional if an image is provided. */
  text?: string;
  /** Data URLs or https URLs for the food photo(s) — e.g. a dish shot from two angles, or a menu page plus a closeup of one item. Optional. */
  imageUrls?: string[];
  /** Language the "description" field should be written in. Defaults to English. */
  lang?: "en" | "he";
  /**
   * Recent chat turns preceding this message — a chat log_meal message is
   * often a bare confirmation ("add it", "log that") referring to a food
   * named a few turns earlier, not a standalone food description. Without
   * this, the model has nothing to extract an item from and either
   * hallucinates something ungrounded or fails schema validation outright.
   */
  history?: { role: "user" | "assistant"; content: string }[];
}

/**
 * Appended at call time rather than baked into the (admin-editable, stored)
 * systemPrompt — a user-stated number should always win over the model's own
 * estimate for that same field, but this constraint shouldn't depend on the
 * admin having remembered to word the stored prompt that way.
 */
const EXPLICIT_VALUE_INSTRUCTION =
  "\n\nIf the user's text explicitly states a calorie or protein value for an item (e.g. \"140 calorie protein shake\", \"an apple, 95 kcal\"), you MUST use that exact number for that field — do not substitute your own estimate — and set that field's boolean flag (\"explicitCalories\"/\"explicitProtein\") to true. Otherwise estimate normally and omit or leave that flag false." +
  " Also include for each item an \"estimatedGrams\" field: your best-guess portion weight in grams as a plain number." +
  " Also include a \"usdaSearchTerm\" field: a specific search phrase for grounding this food's real nutrition values — name the base ingredient AND its preparation/state (e.g. \"white rice, cooked\" not just \"rice\"; \"tilapia\" for a fish called \"אמנון\"/\"Amnon\" in Hebrew/Israeli usage, plus \"raw\" or \"cooked\" if known), always in English regardless of what language the \"description\" field is written in. A bare single-word term like \"rice\" tends to match unrelated products (crackers, flour, snacks) — always qualify it." +
  " EXCEPTION: if this is a specific packaged/branded product (a bottled drink, a snack bar, anything with a visible brand name and product line on its label/packaging), put the exact brand + product name here instead (e.g. \"Yotvata PRO Breakfast banana oat protein drink\", not a generic description) — a generic ingredient database won't have it, but naming it exactly lets a web lookup find the real label values instead of guessing." +
  " Group ingredients of ONE composite dish into a SINGLE item, not one item per ingredient — e.g. \"salad with red bell pepper, a bit of salt and pepper, olive oil, and a bit of parsley\" is ONE item named after the dish (\"salad\"), with its total calories/protein covering everything in it, and an \"ingredients\" field listing each ingredient the user actually mentioned (in the same language as \"description\"). Only split into separate items when the user is clearly describing distinct, separately-eaten foods (e.g. \"rice and grilled chicken\" is 2 items) — components of a single dish are never split out individually. Omit \"ingredients\" entirely for a plain single-food item with nothing to list (e.g. \"an apple\").";

export async function parseNutrition(input: ParseInput): Promise<ParsedNutrition> {
  if (!input.text && !input.imageUrls?.length) {
    throw new Error("parseNutrition requires text or imageUrls");
  }

  const config = await getNutritionParserConfig();

  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  if (input.text) content.push({ type: "text", text: input.text });
  for (const url of input.imageUrls ?? []) {
    content.push({ type: "image_url", image_url: { url } });
  }

  // Appended at call time rather than baked into the (admin-editable, stored
  // in English) systemPrompt — otherwise every admin edit would need to
  // re-specify this, and it'd silently drop out if they don't.
  const languageInstruction =
    input.lang === "he"
      ? "\n\nWrite the \"description\" field in Hebrew, regardless of what language the input is in."
      : "\n\nWrite the \"description\" field in English, regardless of what language the input is in.";

  const multiImageInstruction =
    (input.imageUrls?.length ?? 0) > 1
      ? "\n\nMore than one photo was sent together — they may be different angles of the SAME food/plate (don't double-count it as separate items) or genuinely different foods eaten together (e.g. a plate photo plus a drink's label) — use all of them together to identify what's actually being logged."
      : "";

  const historyMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = (input.history ?? [])
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.content }));

  const completion = await getOpenAIClient().chat.completions.create({
    model: config.model,
    response_format: { type: "json_object" },
    // Minimize run-to-run variance for the same input. Not a hard guarantee
    // of determinism (OpenAI notes seed/temperature reduce but don't
    // eliminate drift, especially across model version changes), but this
    // is the closest the API gets.
    temperature: config.temperature,
    seed: config.seed,
    messages: [
      {
        role: "system",
        content:
          config.systemPrompt +
          languageInstruction +
          EXPLICIT_VALUE_INSTRUCTION +
          multiImageInstruction +
          (historyMessages.length > 0
            ? "\n\nRecent conversation turns are included before the final message for context — if that final message doesn't itself describe food (e.g. it's just \"add it\"/\"log that\"), figure out which food was being discussed and extract that instead of failing."
            : ""),
      },
      ...historyMessages,
      { role: "user", content },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("Empty response from nutrition parser");

  const parsed = parsedSchema.parse(JSON.parse(raw));

  // Ground simple, named foods against USDA's database (or, failing that, a
  // web search — see webSearchNutrition) instead of trusting the model's
  // own calorie/protein guess. Applies to photo-parsed items too, not just
  // text: a composite home-cooked plate genuinely won't match anything and
  // just keeps the model's own estimate (usda/web come back null), but a
  // specific packaged/branded product often DOES have real data findable
  // this way, and a photo with no visible calorie count on the label is
  // exactly the case where the model's freehand guess is least reliable.
  // Skipped for any field the user explicitly stated (that always wins).
  for (const item of parsed.items) {
    if (!item.estimatedGrams || (item.explicitCalories && item.explicitProtein)) continue;
    const term = item.usdaSearchTerm || item.description;
    const usda = (await lookupUsdaNutrients(term)) ?? (await webSearchNutrition(term));
    if (!usda) continue;
    if (!item.explicitCalories) {
      item.calories = Math.round((usda.caloriesPer100g * item.estimatedGrams) / 100);
    }
    if (!item.explicitProtein) {
      item.protein = Math.round(((usda.proteinPer100g * item.estimatedGrams) / 100) * 10) / 10;
    }
  }

  return {
    items: parsed.items.map((item) => ({
      description: item.description,
      calories: item.calories,
      protein: item.protein,
      carbs: item.carbs,
      fat: item.fat,
      fiber: item.fiber,
      confidence: item.confidence,
      grams: item.estimatedGrams,
      ingredients: item.ingredients,
    })),
  };
}

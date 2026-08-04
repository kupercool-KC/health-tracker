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
import { lookupUsdaNutrients } from "./usda";

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
});
const parsedSchema = z.object({ items: z.array(itemSchema).min(1) });

export interface ParseInput {
  /** Free-text message from the chat box. Optional if an image is provided. */
  text?: string;
  /** A data URL or https URL for the food photo. Optional. */
  imageUrl?: string;
  /** Language the "description" field should be written in. Defaults to English. */
  lang?: "en" | "he";
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
  " Also include a \"usdaSearchTerm\" field: a specific, internationally-recognized English search phrase for looking up this food in the USDA nutrition database — name the base ingredient AND its preparation/state (e.g. \"white rice, cooked\" not just \"rice\"; \"tilapia\" for a fish called \"אמנון\"/\"Amnon\" in Hebrew/Israeli usage, plus \"raw\" or \"cooked\" if known). A bare single-word term like \"rice\" tends to match unrelated products (crackers, flour, snacks) — always qualify it. This is always in English regardless of what language the \"description\" field is written in, and should never be a regional or brand name.";

export async function parseNutrition(input: ParseInput): Promise<ParsedNutrition> {
  if (!input.text && !input.imageUrl) {
    throw new Error("parseNutrition requires text or imageUrl");
  }

  const config = await getNutritionParserConfig();

  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  if (input.text) content.push({ type: "text", text: input.text });
  if (input.imageUrl) {
    content.push({ type: "image_url", image_url: { url: input.imageUrl } });
  }

  // Appended at call time rather than baked into the (admin-editable, stored
  // in English) systemPrompt — otherwise every admin edit would need to
  // re-specify this, and it'd silently drop out if they don't.
  const languageInstruction =
    input.lang === "he"
      ? "\n\nWrite the \"description\" field in Hebrew, regardless of what language the input is in."
      : "\n\nWrite the \"description\" field in English, regardless of what language the input is in.";

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
      { role: "system", content: config.systemPrompt + languageInstruction + EXPLICIT_VALUE_INSTRUCTION },
      { role: "user", content },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("Empty response from nutrition parser");

  const parsed = parsedSchema.parse(JSON.parse(raw));

  // Ground simple, named foods against USDA's database instead of trusting
  // the model's own calorie/protein guess. Skipped for photos — a
  // photographed composite dish doesn't map to a single USDA food entry —
  // and skipped for any field the user explicitly stated (that always wins).
  if (!input.imageUrl) {
    for (const item of parsed.items) {
      if (!item.estimatedGrams || (item.explicitCalories && item.explicitProtein)) continue;
      const usda = await lookupUsdaNutrients(item.usdaSearchTerm || item.description);
      if (!usda) continue;
      if (!item.explicitCalories) {
        item.calories = Math.round((usda.caloriesPer100g * item.estimatedGrams) / 100);
      }
      if (!item.explicitProtein) {
        item.protein = Math.round(((usda.proteinPer100g * item.estimatedGrams) / 100) * 10) / 10;
      }
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
    })),
  };
}

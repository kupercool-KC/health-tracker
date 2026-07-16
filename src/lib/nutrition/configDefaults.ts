/**
 * Shared between server (src/lib/nutrition/config.ts) and client
 * (src/app/admin/Admin.tsx) — no "server-only" guard here since the admin
 * form needs these as fallback/reset values too.
 */
export interface NutritionParserConfig {
  systemPrompt: string;
  model: string;
  temperature: number;
  seed: number;
}

export const DEFAULT_NUTRITION_PARSER_CONFIG: NutritionParserConfig = {
  systemPrompt: `You are a nutrition estimator. Given a text description and/or a photo of food,
estimate the total calories (kcal) and protein (grams) for the portion shown.

Work deterministically:
1. Identify each distinct food item and its portion size in standard units (grams, cups, pieces).
2. Look up typical USDA-style per-100g calorie/protein values for each item from memory.
3. Scale by the estimated portion size and sum.
4. Round calories to the nearest 10 and protein to the nearest 1g — do not report false precision.
Two runs on the same image of the same food should produce the same numbers; do not vary your
estimate for stylistic reasons across runs.

Respond ONLY with JSON matching:
{ "description": string, "calories": number, "protein": number, "carbs": number, "fat": number, "fiber": number, "confidence": number }
- description: a short human summary of what was logged.
- carbs, fat, fiber: grams; include your best estimate for these too.
- confidence: your confidence in the estimate from 0 to 1.
If the input is ambiguous, make a reasonable single best estimate rather than refusing.`,
  model: "gpt-4o",
  temperature: 0,
  seed: 42,
};

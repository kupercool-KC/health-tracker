/**
 * Fills in the full nutrient set for items that were logged without parsing (a regular food at its stored
 * values, or an explicit "300 kcal, 20 g protein" log). Calories and protein are never changed; carbs, fat,
 * fiber, sugar, saturated fat and sodium come from one cheap model call and go through the same plausibility
 * checks as parsed meals. Best-effort: any failure leaves the item as it was.
 */
import "server-only";
import { getOpenAIClient } from "@/lib/openai/client";
import type { ParsedNutritionItem } from "@/lib/types";
import { validateNutrients } from "./nutrients";

function needsExtras(item: ParsedNutritionItem): boolean {
  return item.sodium == null && item.sugar == null && item.saturatedFat == null;
}

export async function fillMissingNutrients(items: ParsedNutritionItem[]): Promise<ParsedNutritionItem[]> {
  return Promise.all(
    items.map(async (item) => {
      if (!needsExtras(item)) return item;
      try {
        const completion = await getOpenAIClient().chat.completions.create({
          model: "gpt-4o-mini",
          response_format: { type: "json_object" },
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                "Estimate the full nutrition of one food portion. Keep the given calories and protein exactly. Return realistic carbs, fat, fiber, sugar (total sugars), saturatedFat in grams and sodium in MILLIGRAMS, consistent with each other: protein*4 + carbs*4 + fat*9 within 15% of calories; sugar <= carbs; saturatedFat <= fat; fiber <= carbs. " +
                'Respond ONLY as JSON {"carbs":n,"fat":n,"fiber":n,"sugar":n,"saturatedFat":n,"sodium":n}.',
            },
            {
              role: "user",
              content: `Food: ${item.description}\nCalories: ${item.calories}\nProtein g: ${item.protein}${item.grams ? `\nPortion g: ${item.grams}` : ""}${item.ingredients?.length ? `\nIngredients: ${item.ingredients.join(", ")}` : ""}`,
            },
          ],
        });
        const raw = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as Record<string, unknown>;
        const num = (k: string) => (typeof raw[k] === "number" && (raw[k] as number) >= 0 ? (raw[k] as number) : undefined);
        const candidate = { ...item, carbs: num("carbs"), fat: num("fat"), fiber: num("fiber"), sugar: num("sugar"), saturatedFat: num("saturatedFat"), sodium: num("sodium") };
        const checked = validateNutrients(candidate);
        if (checked.energyMismatch) {
          // Keep only what is independent of the macro split.
          return { ...item, sodium: candidate.sodium, nutrientsEstimated: true };
        }
        return { ...checked.item, nutrientsEstimated: true };
      } catch {
        return item;
      }
    }),
  );
}

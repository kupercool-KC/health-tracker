/**
 * Grounds a food description against USDA's FoodData Central database
 * (free, no auth beyond an API key — https://fdc.nal.usda.gov/api-guide.html)
 * instead of trusting the model's own calorie/protein estimate for simple,
 * named foods. Best-effort: any failure (no match, network error, no API
 * key configured) just returns null and the caller falls back to the
 * model's estimate — this is a refinement, not a required dependency.
 */
import "server-only";

/** USDA FDC nutrient IDs (stable across their API, not configurable). */
const NUTRIENT_ID_ENERGY_KCAL = 1008;
const NUTRIENT_ID_PROTEIN_G = 1003;

interface UsdaFoodNutrient {
  nutrientId: number;
  value: number;
}

interface UsdaFood {
  description: string;
  foodNutrients: UsdaFoodNutrient[];
}

export interface UsdaMatch {
  /** per 100g, as USDA's Foundation/SR Legacy datasets report it */
  caloriesPer100g: number;
  proteinPer100g: number;
  matchedName: string;
}

/**
 * USDA's search ranks by keyword overlap, not by what a person actually
 * means — "white rice" outranks "Flour, rice, white, unenriched" over
 * "Rice, white, ... cooked" purely because "flour" shares more matched
 * terms. Skip any candidate that names a different processed form than the
 * query asked for, so a confidently-wrong substitution (rice flour standing
 * in for rice, fish sticks standing in for fish) doesn't silently win over
 * just trusting the model's own estimate.
 */
const DISQUALIFYING_TERMS = [
  "flour",
  "juice",
  "sauce",
  "syrup",
  "extract",
  "powder",
  "candied",
  "dried",
  "flavored",
  "mix",
  "sticks",
  "breaded",
  "batter",
  "meal,",
];

function isDisqualified(description: string, query: string): boolean {
  const lowerDesc = description.toLowerCase();
  const lowerQuery = query.toLowerCase();
  return DISQUALIFYING_TERMS.some((term) => lowerDesc.includes(term) && !lowerQuery.includes(term));
}

export async function lookupUsdaNutrients(query: string): Promise<UsdaMatch | null> {
  const apiKey = process.env.USDA_FDC_API_KEY || "DEMO_KEY";
  const url =
    `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(apiKey)}` +
    `&pageSize=5&dataType=${encodeURIComponent("Foundation,SR Legacy")}&query=${encodeURIComponent(query)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as { foods?: UsdaFood[] };
    const food = data.foods?.find((f) => !isDisqualified(f.description, query));
    if (!food) return null;

    const energy = food.foodNutrients.find((n) => n.nutrientId === NUTRIENT_ID_ENERGY_KCAL)?.value;
    const protein = food.foodNutrients.find((n) => n.nutrientId === NUTRIENT_ID_PROTEIN_G)?.value;
    if (energy == null || protein == null) return null;

    return { caloriesPer100g: energy, proteinPer100g: protein, matchedName: food.description };
  } catch {
    return null;
  }
}

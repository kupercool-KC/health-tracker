/**
 * Grounds a food description against USDA's FoodData Central database
 * (free, no auth beyond an API key — https://fdc.nal.usda.gov/api-guide.html)
 * instead of trusting the model's own calorie/protein estimate for simple,
 * named foods. Best-effort: any failure (no match, network error, no API
 * key configured) just returns null and the caller falls back to the
 * model's estimate — this is a refinement, not a required dependency.
 */
import "server-only";
import { getOpenAIClient } from "@/lib/openai/client";

/** Cheap/fast model for the yes-or-no match verification below — same tier used for chat intent classification, not the (possibly more expensive, admin-configurable) nutrition parser model. */
const VERIFY_MODEL = "gpt-4o-mini";

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
 * query asked for — a first-pass filter; verifyUsdaMatch below is the real
 * safety net since this list can never be exhaustive.
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

function toMatch(food: UsdaFood): UsdaMatch | null {
  const energy = food.foodNutrients.find((n) => n.nutrientId === NUTRIENT_ID_ENERGY_KCAL)?.value;
  const protein = food.foodNutrients.find((n) => n.nutrientId === NUTRIENT_ID_PROTEIN_G)?.value;
  if (energy == null || protein == null) return null;
  return { caloriesPer100g: energy, proteinPer100g: protein, matchedName: food.description };
}

/** Up to `limit` non-disqualified candidates, best-match first (USDA's own relevance order). */
export async function searchUsdaCandidates(query: string, limit = 4): Promise<UsdaMatch[]> {
  const apiKey = process.env.USDA_FDC_API_KEY || "DEMO_KEY";
  const url =
    `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(apiKey)}` +
    `&pageSize=8&dataType=${encodeURIComponent("Foundation,SR Legacy")}&query=${encodeURIComponent(query)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as { foods?: UsdaFood[] };
    const foods = (data.foods ?? []).filter((f) => !isDisqualified(f.description, query));
    return foods.map(toMatch).filter((m): m is UsdaMatch => m != null).slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * A static keyword filter can't anticipate every mismatch (it didn't catch
 * "rice cakes"/"rice crackers" outranking plain cooked rice, for instance).
 * This asks a cheap model to actually judge whether any candidate matches
 * what a person means by the query — the closest thing to a human sanity
 * check without one in the loop. Returns null (meaning: fall back to the
 * caller's own estimate) on any failure or if the model finds no good match.
 */
export async function verifyUsdaMatch(query: string, candidates: UsdaMatch[]): Promise<UsdaMatch | null> {
  if (candidates.length === 0) return null;
  try {
    const list = candidates.map((c, i) => `${i}: ${c.matchedName}`).join("\n");
    const completion = await getOpenAIClient().chat.completions.create({
      model: VERIFY_MODEL,
      response_format: { type: "json_object" },
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You verify whether a USDA FoodData Central database entry correctly represents a food item as commonly eaten. " +
            "Reject a candidate if it's a different processed form, a snack/derivative product, or simply a different food " +
            "than what's described — even if it shares keywords. Respond with JSON {\"matchIndex\": number|null} — the " +
            "0-based index of the one correct candidate, or null if none of them correctly represent the food.",
        },
        { role: "user", content: `Food: "${query}"\n\nCandidates:\n${list}` },
      ],
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { matchIndex: number | null };
    if (parsed.matchIndex == null) return null;
    return candidates[parsed.matchIndex] ?? null;
  } catch {
    return null;
  }
}

/** Convenience wrapper: search + verify in one call. */
export async function lookupUsdaNutrients(query: string): Promise<UsdaMatch | null> {
  const candidates = await searchUsdaCandidates(query);
  return verifyUsdaMatch(query, candidates);
}

/**
 * USDA's Foundation/SR Legacy datasets only cover common, largely
 * US-centric foods — regional dishes, branded products, and less common
 * ingredients often have nothing to match at all (not a wrong match, just
 * zero candidates). For those, search the web instead of letting the
 * caller fall back straight to the model's unverified memory. Only worth
 * trying once USDA has already come up empty — an extra network round trip
 * per call, not something to run on every lookup.
 */
export async function webSearchNutrition(query: string): Promise<UsdaMatch | null> {
  try {
    const response = await getOpenAIClient().responses.create({
      model: "gpt-4o-mini",
      tools: [{ type: "web_search_preview" }],
      input:
        `Search the web for reliable nutrition data (per 100g) for: "${query}". ` +
        `Respond with ONLY a JSON object, no other text: ` +
        `{"caloriesPer100g": number, "proteinPer100g": number, "source": string} — "source" is the name of the ` +
        `site/database the numbers came from. If you can't find reliable data, respond with ` +
        `{"caloriesPer100g": null, "proteinPer100g": null, "source": null}.`,
    });
    const text = response.output_text;
    const match = text?.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as {
      caloriesPer100g: number | null;
      proteinPer100g: number | null;
      source?: string | null;
    };
    if (parsed.caloriesPer100g == null || parsed.proteinPer100g == null) return null;
    return {
      caloriesPer100g: parsed.caloriesPer100g,
      proteinPer100g: parsed.proteinPer100g,
      matchedName: parsed.source ? `${query} (web: ${parsed.source})` : query,
    };
  } catch {
    return null;
  }
}

/**
 * Converts a unit-based quantity ("1 date", "2 slices", "a handful") of a
 * named food into an estimated portion weight in grams — for when the user
 * knows how much they ate in everyday terms but not the gram weight. Uses
 * the model's general knowledge of typical unit weights (same source the
 * chat nutrition parser already relies on for "one date ≈ 8g" type
 * conversions), not a lookup — best-effort, returns null on any failure so
 * the caller falls back to manual gram entry.
 */
export async function estimateGramsForQuantity(food: string, quantity: string): Promise<number | null> {
  try {
    const completion = await getOpenAIClient().chat.completions.create({
      model: VERIFY_MODEL,
      response_format: { type: "json_object" },
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `Estimate the total weight in grams of the stated quantity of the stated food, using typical/average real-world weights for that unit (e.g. one date ≈ 8g, one slice of bread ≈ 30g, one medium banana ≈ 120g). Respond ONLY as JSON: { "grams": number|null } — null only if the quantity is too vague to estimate at all (not just because it's an unusual unit — make a reasonable best guess whenever possible).`,
        },
        { role: "user", content: `Food: ${food}\nQuantity: ${quantity}` },
      ],
    });
    const raw = completion.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { grams?: number | null };
    return typeof parsed.grams === "number" && parsed.grams > 0 ? parsed.grams : null;
  } catch {
    return null;
  }
}

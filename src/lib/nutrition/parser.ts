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
import { searchWeb } from "@/lib/chat/webSearch";
import { adminDb } from "@/lib/firebase/admin";
import { validateNutrients, type NutrientKey } from "./nutrients";

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
  sugar: z.number().nonnegative().optional(),
  saturatedFat: z.number().nonnegative().optional(),
  sodium: z.number().nonnegative().optional(),
  confidence: z.number().min(0).max(1).optional(),
  estimatedGrams: z.number().nonnegative().optional(),
  explicitCalories: z.boolean().optional(),
  explicitProtein: z.boolean().optional(),
  usdaSearchTerm: z.string().optional(),
  restaurantName: z.string().optional(),
  menuGrounded: z.boolean().optional(),
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

// Safety net alongside EXPLICIT_VALUE_INSTRUCTION below: the model doesn't
// always set explicitCalories/explicitProtein even when the text plainly
// states a number (seen with Hebrew phrasing like "ארוחה של 300 קלוריות
// ו20 גרם חלבון" — the model matched it to a generic "rice" estimate
// instead). Only trusted for a single-item result — with multiple foods in
// one message there's no way to know which number belongs to which item.
const CALORIE_PATTERNS = [/(\d+(?:\.\d+)?)\s*(?:kcal|cal(?:ories?)?)\b/i, /(\d+(?:\.\d+)?)\s*קלוריו?ת/];
const PROTEIN_PATTERNS = [
  /(\d+(?:\.\d+)?)\s*g(?:rams?)?\s*(?:of\s*)?protein\b/i,
  /protein[:\s]+(\d+(?:\.\d+)?)\s*g(?:rams?)?/i,
  /(\d+(?:\.\d+)?)\s*גר(?:ם|'|׳)?\s*חלבון/,
];

function extractExplicitValue(text: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

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
  /**
   * The user's own regularly-logged foods (most habitual first), so a vague
   * reference to "my usual X" can be matched to real past values instead of
   * guessed from scratch. See getFrequentMealsForChat.
   */
  frequentMeals?: { name: string; calories: number; protein: number; grams?: number; ingredients?: string[] }[];
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
  " If the user names a specific restaurant/venue for a dish (e.g. \"[dish name] at [restaurant name]\") — OR clearly refers back to one without repeating its name (e.g. \"their pizza\", \"the burger from that place\", \"שלהם\"/\"מהמקום ההוא\") when a specific restaurant was already established earlier in this conversation — resolve which place is meant from the conversation history, then call the search_restaurant_menu tool with that place and dish name BEFORE estimating — you're looking for what's actually IN the dish (its ingredients/description), not a calorie number (real menus essentially never publish those). If the search finds a real ingredient list/description, use those actual ingredients — not your own generic assumption of a typical version of that dish — to estimate calories/protein the same way you would for any composite dish, and set \"menuGrounded\": true and \"restaurantName\" to the place's name on that item. If the search finds nothing useful, or no specific place was named, fall back to your normal estimate from whatever the user already described, and leave \"menuGrounded\" unset — don't call the tool more than once per distinct restaurant+dish. Either way, when a restaurant is named, ALWAYS populate the \"ingredients\" field with the specific ingredients your estimate is based on (the real ones if the search found them, otherwise the typical ones you assumed for that kind of dish) — the user needs to see exactly what was assumed so they can correct anything that's wrong." +
  " Group ingredients of ONE composite dish into a SINGLE item, not one item per ingredient — e.g. \"salad with red bell pepper, a bit of salt and pepper, olive oil, and a bit of parsley\" is ONE item named after the dish (\"salad\"), with its total calories/protein covering everything in it, and an \"ingredients\" field listing each ingredient the user actually mentioned (in the same language as \"description\"). Only split into separate items when the user is clearly describing distinct, separately-eaten foods (e.g. \"rice and grilled chicken\" is 2 items) — components of a single dish are never split out individually. Omit \"ingredients\" entirely for a plain single-food item with nothing to list (e.g. \"an apple\")." +
  " The \"description\" MUST be the specific food/dish name the user actually used (e.g. \"half a protein shake\", \"חצי משקה חלבון\") — never replace it with a generic word like \"meal\"/\"ארוחה\" or \"dish\"/\"מנה\" just because the user also gave explicit calorie/protein numbers. Only use a generic \"meal\"/\"ארוחה\" (or \"portion\"/\"מנה\") as the description when the user explicitly logged it that way without naming any specific food (e.g. \"log a meal, 600 calories 40g protein\", \"תרשום ארוחה של 600 קלוריות ו-40 גרם חלבון\").";

/** Appended at call time (not in the admin-editable stored prompt) so the full nutrient set is always requested. */
const NUTRIENTS_INSTRUCTION =
  "\n\nFor EVERY item also return your best estimate of: carbs, fat, fiber, sugar (total sugars) and saturatedFat in grams, and sodium in MILLIGRAMS — plain numbers, never omitted, rounded sensibly (no false precision). They must be consistent with each other and with calories: protein*4 + carbs*4 + fat*9 should be within about 15% of calories (alcohol aside); sugar <= carbs; saturatedFat <= fat; fiber <= carbs. If the user or a label explicitly states one of these values for an item (e.g. \"800 mg sodium\"), use that exact number.";

const SEARCH_MENU_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_restaurant_menu",
    description:
      "Search the web for what's actually IN a specific dish at a named restaurant/venue — its ingredients or menu description, not a calorie number (real menus essentially never publish those). Use this whenever the user names a specific place for a dish, before falling back to a generic estimate of that dish type. Returns a free-text summary of what was found, or null if the menu/dish couldn't be found online.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'A short, simple, natural search query — just the place, city, and "menu" (e.g. "[restaurant name] [city] menu"). Prefer English even when the conversation is in Hebrew — it tends to surface more results (delivery-platform menus, review sites). Never add extra qualifier words like "ingredients"/"nutrition facts" to the query itself — that tends to return nothing even for a well-known, easily findable place; search for the plain menu and read the dish\'s ingredients off of whatever description comes back.',
        },
      },
      required: ["query"],
    },
  },
};

const MAX_MENU_SEARCH_ROUNDS = 3;

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

  const frequentMealsInstruction = input.frequentMeals?.length
    ? "\n\nThe user's own regularly-logged foods, most habitual first (name — calories, protein" +
      ", estimated grams, ingredients when known):\n" +
      input.frequentMeals
        .map(
          (m) =>
            `- ${m.name} — ${m.calories} kcal, ${m.protein}g protein` +
            (m.grams != null ? `, ~${m.grams}g` : "") +
            (m.ingredients?.length ? `, ingredients: ${m.ingredients.join(", ")}` : ""),
        )
        .join("\n") +
      "\n\nIf the final message vaguely names a food (e.g. \"my usual protein shake\", \"שייק חלבון\", \"the usual omelet\") that reasonably matches one of these — even worded differently — treat it as that SAME food: use its calories/protein/grams as your estimate, and set \"description\" to that exact stored name so it keeps matching next time. An explicit number the user states in this message always overrides the stored value for that field (see the explicit-value rule above) — this list is only for filling in what the message itself leaves unstated. Only match when reasonably confident it's the same food; a message describing something clearly different (a different dish, a different brand, explicit different ingredients) is NOT a match — estimate it normally instead."
    : "";

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        config.systemPrompt +
        languageInstruction +
        EXPLICIT_VALUE_INSTRUCTION +
        NUTRIENTS_INSTRUCTION +
        multiImageInstruction +
        frequentMealsInstruction +
        (historyMessages.length > 0
          ? "\n\nRecent conversation turns are included before the final message for context ONLY. Three specific uses are allowed: (a) if the final message doesn't itself describe any food (e.g. it's just \"add it\"/\"log that\"), figure out which food was being discussed in the preceding turns and extract that; (b) if the final message explicitly asks to include an earlier-mentioned food too — by naming it directly, or by a clear reference like \"what I ate before\", \"the other thing I mentioned\", \"combine everything from this session\" — include that food as well, using the calorie/protein values already established for it earlier if they were stated there; (c) if the final message refers to a restaurant/venue by pronoun or vague reference (\"their pizza\", \"the burger from that place\", \"שלהם\") instead of repeating its name, resolve WHICH place is meant from the preceding turns — this is identifying an entity already being discussed, not adding an extra food item, so it's allowed even though it draws on history. Otherwise (the normal case: the final message plainly describes new food(s) with no reference to anything earlier), extract items ONLY for what it actually describes — do NOT add other foods just because they happen to appear earlier in this history. An earlier food that the final message doesn't reference at all was a separate, already-handled request (already logged or already rejected), not part of what's being logged now."
          : ""),
    },
    ...historyMessages,
    { role: "user", content },
  ];

  let raw: string | null | undefined;
  for (let round = 0; round < MAX_MENU_SEARCH_ROUNDS; round++) {
    const completion = await getOpenAIClient().chat.completions.create({
      model: config.model,
      response_format: { type: "json_object" },
      // Minimize run-to-run variance for the same input. Not a hard guarantee
      // of determinism (OpenAI notes seed/temperature reduce but don't
      // eliminate drift, especially across model version changes), but this
      // is the closest the API gets.
      temperature: config.temperature,
      seed: config.seed,
      tools: [SEARCH_MENU_TOOL],
      messages,
    });

    const choice = completion.choices[0]?.message;
    if (!choice) throw new Error("Empty response from nutrition parser");

    const toolCalls = choice.tool_calls?.filter((c) => c.type === "function");
    if (!toolCalls || toolCalls.length === 0) {
      raw = choice.content;
      break;
    }

    messages.push(choice);
    for (const call of toolCalls) {
      let query = "";
      try {
        query = JSON.parse(call.function.arguments).query ?? "";
      } catch {
        // malformed arguments — fall through with an empty query, handled as "nothing found" below
      }
      const result = query ? await searchWeb(query) : null;
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result ?? "No menu/dish information found online for this search.",
      });
    }
  }
  if (!raw) throw new Error("Empty response from nutrition parser");

  const parsed = parsedSchema.parse(JSON.parse(raw));

  // Deterministic catch for explicit numbers the model's own
  // explicitCalories/explicitProtein flags missed — see CALORIE_PATTERNS.
  if (parsed.items.length === 1 && input.text) {
    const [item] = parsed.items;
    if (!item.explicitCalories) {
      const explicitCalories = extractExplicitValue(input.text, CALORIE_PATTERNS);
      if (explicitCalories != null) {
        item.calories = explicitCalories;
        item.explicitCalories = true;
      }
    }
    if (!item.explicitProtein) {
      const explicitProtein = extractExplicitValue(input.text, PROTEIN_PATTERNS);
      if (explicitProtein != null) {
        item.protein = explicitProtein;
        item.explicitProtein = true;
      }
    }
  }

  // Ground simple, named foods against USDA's database (or, failing that, a
  // web search — see webSearchNutrition) instead of trusting the model's
  // own calorie/protein guess. Applies to photo-parsed items too, not just
  // text: a composite home-cooked plate genuinely won't match anything and
  // just keeps the model's own estimate (usda/web come back null), but a
  // specific packaged/branded product often DOES have real data findable
  // this way, and a photo with no visible calorie count on the label is
  // exactly the case where the model's freehand guess is least reliable.
  // Skipped for any field the user explicitly stated (that always wins).
  //
  // Kept in a parallel array rather than added onto `item` itself — `item`
  // is zod-parsed output typed by itemSchema, which doesn't carry these
  // fields — so provenance stays index-aligned with parsed.items until the
  // final map below.
  const provenance: { source: "explicit" | "usda" | "web" | "model"; note: string; extrasGrounded?: boolean }[] = [];
  for (const item of parsed.items) {
    // Already estimated from the restaurant's own real menu/ingredients via
    // search_restaurant_menu above — trust that over a generic USDA/web
    // lookup on a stripped-down ingredient term, which would just throw away
    // the restaurant-specific grounding the model already did.
    if (item.menuGrounded) {
      provenance.push({
        source: "web",
        note: item.restaurantName
          ? input.lang === "he"
            ? `הוערך לפי התפריט/הרכיבים בפועל של ${item.restaurantName} (חיפוש ברשת).`
            : `Estimated from ${item.restaurantName}'s actual menu/ingredients (web search).`
          : nutritionNote("web", null, input.lang),
      });
      continue;
    }
    const fullyExplicit = !!(item.explicitCalories && item.explicitProtein);
    if (!item.estimatedGrams || fullyExplicit) {
      provenance.push({
        source: fullyExplicit ? "explicit" : "model",
        note: nutritionNote(fullyExplicit ? "explicit" : "model", null, input.lang),
      });
      continue;
    }
    const term = item.usdaSearchTerm || item.description;
    const usda = await lookupUsdaNutrients(term);
    const web = usda ? null : await webSearchNutrition(term);
    const match = usda ?? web;
    if (!match) {
      provenance.push({ source: "model", note: nutritionNote("model", null, input.lang) });
      continue;
    }
    if (!item.explicitCalories) {
      item.calories = Math.round((match.caloriesPer100g * item.estimatedGrams) / 100);
    }
    if (!item.explicitProtein) {
      item.protein = Math.round(((match.proteinPer100g * item.estimatedGrams) / 100) * 10) / 10;
    }
    // Extra nutrients: when USDA reports a value, it replaces the model's guess (scaled by portion).
    const scale = item.estimatedGrams / 100;
    const r1 = (n: number) => Math.round(n * 10) / 10;
    let grounded = false;
    if (match.carbsPer100g != null) { item.carbs = r1(match.carbsPer100g * scale); grounded = true; }
    if (match.fatPer100g != null) { item.fat = r1(match.fatPer100g * scale); grounded = true; }
    if (match.fiberPer100g != null) { item.fiber = r1(match.fiberPer100g * scale); grounded = true; }
    if (match.sugarPer100g != null) { item.sugar = r1(match.sugarPer100g * scale); grounded = true; }
    if (match.satFatPer100g != null) { item.saturatedFat = r1(match.satFatPer100g * scale); grounded = true; }
    if (match.sodiumMgPer100g != null) { item.sodium = Math.round(match.sodiumMgPer100g * scale); grounded = true; }
    provenance.push({ source: usda ? "usda" : "web", note: nutritionNote(usda ? "usda" : "web", match, input.lang), extrasGrounded: grounded });
  }

  // Quality control on the extra nutrients: one silent repair attempt on an energy mismatch, then drop what
  // still doesn't add up (kcal/protein are never touched). Rejections are logged for review.
  const checked = await Promise.all(
    parsed.items.map(async (item) => {
      const hasAlcohol = /beer|wine|vodka|whisk|alcohol|בירה|יין|וודקה|ויסקי|אלכוהול/i.test(item.description);
      let result = validateNutrients(item, { hasAlcohol });
      if (result.energyMismatch) {
        const repaired = await repairMacros(item);
        if (repaired) {
          result = validateNutrients({ ...item, ...repaired }, { hasAlcohol });
        }
        if (result.energyMismatch) {
          for (const k of ["carbs", "fat", "fiber", "sugar", "saturatedFat"] as NutrientKey[]) {
            (result.item as Record<string, unknown>)[k] = undefined;
            if (!result.dropped.includes(k)) result.dropped.push(k);
          }
        }
      }
      if (result.dropped.length > 0) {
        adminDb
          .collection("nutrientRejections")
          .add({
            createdAt: new Date().toISOString(),
            description: item.description,
            calories: item.calories,
            protein: item.protein,
            raw: { carbs: item.carbs, fat: item.fat, fiber: item.fiber, sugar: item.sugar, saturatedFat: item.saturatedFat, sodium: item.sodium },
            dropped: result.dropped,
          })
          .catch(() => {});
      }
      return result.item;
    }),
  );
  parsed.items.splice(0, parsed.items.length, ...checked);

  return {
    items: parsed.items.map((item, i) => ({
      description: item.description,
      calories: item.calories,
      protein: item.protein,
      carbs: item.carbs,
      fat: item.fat,
      fiber: item.fiber,
      sugar: item.sugar,
      saturatedFat: item.saturatedFat,
      sodium: item.sodium,
      // Model-only unless USDA grounded the extras or the user stated the numbers.
      nutrientsEstimated: !(provenance[i]?.extrasGrounded || provenance[i]?.source === "explicit"),
      confidence: item.confidence,
      grams: item.estimatedGrams,
      ingredients: item.ingredients,
      nutritionSource: provenance[i]?.source,
      nutritionNote: provenance[i]?.note,
      restaurantName: item.restaurantName,
      restaurantMenuNotFound: !!(item.restaurantName && !item.menuGrounded),
    })),
  };
}

/** One-line, already-localized explanation of how an item's numbers were determined — see MealEntry.nutritionNote. */
function nutritionNote(
  source: "explicit" | "usda" | "web" | "model",
  match: { matchedName: string } | null,
  lang: "en" | "he" = "en",
): string {
  if (source === "explicit") {
    return lang === "he" ? "צוין במלל שלך ונעשה בו שימוש כפי שהוא." : "Stated in your message and used as-is.";
  }
  if (match) {
    return lang === "he" ? `הותאם למאגר תזונה: ${match.matchedName}.` : `Matched to a nutrition database: ${match.matchedName}.`;
  }
  return lang === "he" ? "הערכת AI — לא נמצא מקור מאומת." : "AI estimate — no verified source matched.";
}

/** One cheap re-ask: make carbs/fat consistent with the stated calories and protein. Returns null on any failure. */
async function repairMacros(item: { description: string; calories: number; protein: number; carbs?: number; fat?: number }): Promise<{ carbs: number; fat: number } | null> {
  try {
    const completion = await getOpenAIClient().chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            'Given a food and its calories and protein, return realistic carbs and fat in grams so that protein*4 + carbs*4 + fat*9 is within 10% of the calories. Respond ONLY as JSON {"carbs": number, "fat": number}.',
        },
        { role: "user", content: `Food: ${item.description}\nCalories: ${item.calories}\nProtein g: ${item.protein}\nPrevious guess: carbs ${item.carbs}, fat ${item.fat}` },
      ],
    });
    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as { carbs?: number; fat?: number };
    if (typeof parsed.carbs === "number" && typeof parsed.fat === "number" && parsed.carbs >= 0 && parsed.fat >= 0) {
      return { carbs: parsed.carbs, fat: parsed.fat };
    }
    return null;
  } catch {
    return null;
  }
}

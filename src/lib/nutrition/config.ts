/**
 * Nutrition parser config — editable from /admin, stored at
 * appConfig/nutritionParser. parseNutrition() reads this at request time via
 * the Admin SDK (bypasses firestore.rules, same as every other server write
 * in this app) and falls back to these defaults if unconfigured, so behavior
 * doesn't regress before the admin ever visits the page.
 */
import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { DEFAULT_NUTRITION_PARSER_CONFIG, type NutritionParserConfig } from "./configDefaults";

export type { NutritionParserConfig };

const CONFIG_DOC_PATH = ["appConfig", "nutritionParser"] as const;

export async function getNutritionParserConfig(): Promise<NutritionParserConfig> {
  const snap = await adminDb.collection(CONFIG_DOC_PATH[0]).doc(CONFIG_DOC_PATH[1]).get();
  const stored = snap.data() as Partial<NutritionParserConfig> | undefined;
  return {
    ...DEFAULT_NUTRITION_PARSER_CONFIG,
    model: process.env.OPENAI_MODEL ?? DEFAULT_NUTRITION_PARSER_CONFIG.model,
    ...stored,
  };
}

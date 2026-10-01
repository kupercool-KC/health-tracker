/**
 * Admin-SDK counterpart to src/lib/dashboard/queries.ts's getFrequentMeals —
 * that one runs client-side with the browser Firestore SDK for the "recent
 * meals" picker on /today; this runs server-side (parseNutrition has no
 * user session, only a uid) so the chat/WhatsApp parser can recognize a
 * vaguely-described regular food ("my usual protein shake") and reuse its
 * real logged values instead of guessing from scratch.
 */
import "server-only";
import { FieldPath } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import type { MealDay } from "@/lib/types";

export interface FrequentMealForChat {
  name: string;
  calories: number;
  protein: number;
  carbs?: number;
  fat?: number;
  grams?: number;
  ingredients?: string[];
}

const WINDOW_DAYS = 30;
const HALF_LIFE_DAYS = 7;
const LIMIT = 12;

function dateKeyDaysAgo(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/**
 * Same recency-decayed ranking and "latest values win" logic as
 * getFrequentMeals (see its doc comment) — kept in sync deliberately rather
 * than shared, since one reads via the client SDK and one via admin.
 */
export async function getFrequentMealsForChat(uid: string): Promise<FrequentMealForChat[]> {
  const col = adminDb.collection("users").doc(uid).collection("meals");
  const snap = await col.where(FieldPath.documentId(), ">=", dateKeyDaysAgo(WINDOW_DAYS)).get();
  const days = snap.docs.map((d) => d.data() as MealDay);

  const now = Date.now();
  // Per food name: the value that keeps coming back wins (recency-weighted vote), not simply the latest log —
  // one-off different entries (another brand, a mistake) used to overwrite a shake the user has logged 20 times at 128/26.
  type Variant = { weight: number; lastTs: number; calories: number; protein: number; carbs?: number; fat?: number; grams?: number; ingredients?: string[] };
  const groups = new Map<string, { name: string; weight: number; variants: Map<string, Variant> }>();
  for (const day of days) {
    const daysAgo = Math.max(0, (now - new Date(`${day.date}T00:00:00Z`).getTime()) / 86_400_000);
    const decay = Math.pow(0.5, daysAgo / HALF_LIFE_DAYS);
    for (const entry of day.entries ?? []) {
      const key = entry.name.trim().toLowerCase();
      if (!key) continue;
      const g = groups.get(key) ?? { name: entry.name.trim(), weight: 0, variants: new Map() };
      g.name = entry.name.trim();
      g.weight += decay;
      const vkey = `${Math.round(entry.calories)}|${Math.round(entry.protein)}`;
      const v = g.variants.get(vkey) ?? { weight: 0, lastTs: 0, calories: entry.calories, protein: entry.protein };
      v.weight += 1 + decay;
      v.lastTs = Math.max(v.lastTs, new Date(entry.time ?? day.date).getTime());
      v.carbs = entry.carbs; v.fat = entry.fat; v.grams = entry.grams; v.ingredients = entry.ingredients;
      g.variants.set(vkey, v);
      groups.set(key, g);
    }
  }
  return Array.from(groups.values())
    .sort((a, b) => b.weight - a.weight)
    .slice(0, LIMIT)
    .map((g) => {
      const best = [...g.variants.values()].sort((x, y) => y.weight - x.weight || y.lastTs - x.lastTs)[0];
      return {
        name: g.name,
        calories: Math.round(best.calories),
        protein: Math.round(best.protein * 10) / 10,
        carbs: best.carbs,
        fat: best.fat,
        grams: best.grams,
        ingredients: best.ingredients,
      };
    });
}

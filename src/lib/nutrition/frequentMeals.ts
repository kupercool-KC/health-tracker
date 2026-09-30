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
  const groups = new Map<
    string,
    { name: string; weight: number; calories: number; protein: number; carbs?: number; fat?: number; grams?: number; ingredients?: string[] }
  >();
  for (const day of days) {
    const daysAgo = Math.max(0, (now - new Date(`${day.date}T00:00:00Z`).getTime()) / 86_400_000);
    const decay = Math.pow(0.5, daysAgo / HALF_LIFE_DAYS);
    for (const entry of day.entries ?? []) {
      const key = entry.name.trim().toLowerCase();
      if (!key) continue;
      const g = groups.get(key) ?? { name: entry.name.trim(), weight: 0, calories: 0, protein: 0 };
      g.name = entry.name.trim();
      g.weight += decay;
      g.calories = entry.calories;
      g.protein = entry.protein;
      g.carbs = entry.carbs;
      g.fat = entry.fat;
      g.grams = entry.grams;
      g.ingredients = entry.ingredients;
      groups.set(key, g);
    }
  }
  return Array.from(groups.values())
    .sort((a, b) => b.weight - a.weight)
    .slice(0, LIMIT)
    .map((g) => ({
      name: g.name,
      calories: Math.round(g.calories),
      protein: Math.round(g.protein * 10) / 10,
      carbs: g.carbs,
      fat: g.fat,
      grams: g.grams,
      ingredients: g.ingredients,
    }));
}

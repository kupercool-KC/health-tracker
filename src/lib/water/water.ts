/** Water tracking: shared helpers (client + server safe). Amounts are always millilitres. */

/** ~33 ml per kg of body weight, rounded to the nearest 250 ml, clamped to a sensible 1.5–4 L range. */
export function defaultWaterGoalMl(weightKg: number | undefined): number {
  const w = weightKg && weightKg > 25 && weightKg < 300 ? weightKg : 70;
  return Math.min(4000, Math.max(1500, Math.round((w * 33) / 250) * 250));
}

export const WATER_QUICK_ADD_ML = [250, 500, 750];
export const MAX_WATER_ENTRY_ML = 5000;

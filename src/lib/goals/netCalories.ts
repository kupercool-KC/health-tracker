/**
 * Net calorie balance = calories consumed − (calories burned × factor%).
 * The factor defaults to 50% (not 100%) because workout-calorie estimates run
 * optimistic — crediting only half keeps the deficit conservative. Shared
 * between client UI (Today/History/Profile) and server code (chat) so both
 * sides of the app agree on the same formula.
 */
export function computeNetCalories(calories: number, burned: number, netCalorieBurnFactor: number): number {
  return calories - burned * (netCalorieBurnFactor / 100);
}

export const DEFAULT_NET_CALORIE_BURN_FACTOR = 50;

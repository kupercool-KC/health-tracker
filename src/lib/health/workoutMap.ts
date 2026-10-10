/**
 * Apple Health workout types → our workout categories, plus helpers shared by the importer (server) and the
 * client. `hkType` is the type string reported by the HealthKit plugin (lower camel case, e.g. "functionalStrengthTraining").
 */
import type { ActivityLevel, WorkoutType } from "@/lib/types";

const HK_TO_CATEGORY: Record<string, WorkoutType> = {
  running: "running", runningTreadmill: "running", trackAndField: "running",
  walking: "walking", hiking: "walking", wheelchairWalkPace: "walking",
  cycling: "cycling", bikingStationary: "cycling", handCycling: "cycling",
  swimming: "swimming", swimmingPool: "swimming", swimmingOpenWater: "swimming", waterFitness: "swimming", waterPolo: "swimming",
  traditionalStrengthTraining: "strength", functionalStrengthTraining: "strength", strengthTraining: "strength", weightlifting: "strength",
  coreTraining: "strength", crossCountrySkiing: "other", benchPress: "strength", deadlift: "strength", barbellShoulderPress: "strength",
  yoga: "yoga", pilates: "yoga", mindAndBody: "yoga", barre: "yoga", taiChi: "yoga", flexibility: "yoga", stretching: "yoga",
  highIntensityIntervalTraining: "hiit", crossTraining: "hiit", mixedCardio: "hiit", bootCamp: "hiit", jumpRope: "hiit", stairClimbing: "hiit", stairs: "hiit", elliptical: "hiit", rowing: "hiit", rowingMachine: "hiit",
  // No Apple type for padel: racket sports are reported as one of these, so they are `other` until the user tells Lily.
  tennis: "other", paddleSports: "other", racquetball: "other", squash: "other", badminton: "other", tableTennis: "other", pickleball: "other",
};

/** Racket-type workouts whose category is learned per user (a padel player usually records "tennis"/"paddle sports"). */
export const RACKET_HK_TYPES = new Set(["tennis", "paddleSports", "racquetball", "squash", "badminton", "tableTennis", "pickleball"]);

export function categoryOfHk(hkType: string): WorkoutType {
  return HK_TO_CATEGORY[hkType] ?? "other";
}

/** "functionalStrengthTraining" → "Functional Strength Training" */
export function displayNameOfHk(hkType: string): string {
  const spaced = hkType.replace(/([A-Z])/g, " $1").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const NAME_KEYWORDS: [RegExp, WorkoutType][] = [
  [/run|jog|ריצ|ג'וג|treadmill|הליכון/i, "running"],
  [/walk|hike|הליכ|טיול/i, "walking"],
  [/cycl|bike|ride|spinning|אופני|רכיב/i, "cycling"],
  [/swim|שחי|בריכ/i, "swimming"],
  [/strength|weight|gym|lift|core|כוח|משקול|חדר כושר|כושר/i, "strength"],
  [/yoga|pilates|stretch|יוגה|פילאטיס|מתיחות/i, "yoga"],
  [/hiit|interval|cross|boot|אינטרוו|קרוספיט/i, "hiit"],
  [/padel|פאדל/i, "padel"],
];

/** Category for a free-text workout name (manual / chat workouts). */
export function categoryOfName(name: string): WorkoutType {
  for (const [re, cat] of NAME_KEYWORDS) if (re.test(name)) return cat;
  return "other";
}

/** Sessions per week → activity level. */
export function activityLevelFromSessions(sessionsPerWeek: number): ActivityLevel {
  if (sessionsPerWeek > 7) return "veryIntense";
  if (sessionsPerWeek >= 6) return "intense";
  if (sessionsPerWeek >= 3) return "moderate";
  if (sessionsPerWeek >= 1) return "light";
  return "sedentary";
}

/**
 * A manual/chat workout counts as the same session as a Health one when they fall on the same local day, share a
 * category and have a similar duration. (Manual workouts record the logging time, not the real start, so clock
 * overlap alone can't be trusted.)
 */
export function isSameSession(manual: { category: WorkoutType; durationSec: number; date: string }, health: { category: WorkoutType; durationSec: number; date: string }): boolean {
  if (manual.date !== health.date || manual.category !== health.category) return false;
  const tolerance = Math.max(600, health.durationSec * 0.35);
  return Math.abs(manual.durationSec - health.durationSec) <= tolerance;
}

/** Median helper for steps/sleep. */
export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

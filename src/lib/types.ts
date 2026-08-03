/**
 * Core domain models. These mirror the Firestore layout documented in
 * docs/data-model.md. Timestamps are stored as ISO-8601 strings both at the
 * API boundary and at rest, so range queries can compare them lexically.
 */

/** A single logged meal within a day's MealDay doc. */
export interface MealEntry {
  id: string;
  /** ISO-8601 timestamp of when the food was consumed/logged. */
  time: string;
  /** Short human summary of what was logged. */
  name: string;
  calories: number;
  /** grams */
  protein: number;
  carbs?: number;
  fat?: number;
  fiber?: number;
  /** Estimated portion weight in grams, when known — used for USDA grounding and the frequent-meals picker. */
  grams?: number;
  mealType?: "breakfast" | "lunch" | "dinner" | "snack";
  /** Where this came from, for auditing the parse. */
  source: "text" | "photo";
  /** Model confidence 0..1, when the parser provides one. */
  confidence?: number;
  confirmedAt: string;
}

/** users/{uid}/meals/{date} — one doc per day (date = yyyy-mm-dd). */
export interface MealDay {
  date: string;
  entries: MealEntry[];
  totals: { calories: number; protein: number; carbs: number; fat: number };
}

/** A workout pushed in from Apple Health via Health Auto Export. */
export interface Workout {
  id: string;
  userId: string;
  /** e.g. "Running", "Strength Training" — Apple's HKWorkoutActivityType name. */
  type: string;
  /** yyyy-mm-dd, local to the device that recorded it */
  date: string;
  startTime: string;
  endTime: string;
  /** seconds */
  duration: number;
  /** meters */
  distance?: number;
  /** seconds per km */
  pace?: number;
  heartRate?: { avg?: number; max?: number };
  calories?: number;
  /** meters */
  elevationGain?: number;
  source: "appleHealth" | "manual";
  /** Stable id from the exporting app, used to dedupe re-imports (also the doc id). */
  externalId: string;
  syncedAt: string;
}

/** users/{uid}/steps/{date} — one doc per day (date = yyyy-mm-dd), last write wins. */
export interface DailySteps {
  date: string;
  steps: number;
  source: "manual" | "photo";
  syncedAt: string;
}

/** Result of parsing a manual steps entry (text and/or a screenshot of a phone's health/fitness app). */
export interface ParsedSteps {
  steps: number;
  confidence?: number;
}

/**
 * Result of parsing a manually-logged workout (screenshot of a workout
 * summary and/or a text description), before it becomes a Workout.
 */
export interface ParsedWorkout {
  type: string;
  /** seconds */
  durationSec: number;
  /** meters */
  distanceMeters?: number;
  /** seconds per km */
  paceSecPerKm?: number;
  calories?: number;
  heartRateAvg?: number;
  heartRateMax?: number;
  /** meters */
  elevationGainMeters?: number;
  confidence?: number;
}

/** A single distinct food identified within one parse call. */
export interface ParsedNutritionItem {
  description: string;
  calories: number;
  protein: number;
  carbs?: number;
  fat?: number;
  fiber?: number;
  confidence?: number;
  /** Estimated portion weight in grams, when known. */
  grams?: number;
}

/**
 * Result of parsing a nutrition input, before it becomes one or more
 * MealEntry rows. A single message can describe several distinct foods
 * (e.g. "2 schnitzels and a salad") — each becomes its own item/entry.
 */
export interface ParsedNutrition {
  items: ParsedNutritionItem[];
}

export type Goal = "buildMuscle" | "cut" | "loseWeight" | "maintain";
export type ActivityLevel = "sedentary" | "light" | "moderate" | "intense" | "veryIntense";
export type WorkoutType = "strength" | "running" | "walking" | "cycling" | "swimming" | "yoga" | "padel" | "hiit" | "other";
export type DietaryPref = "everything" | "vegetarian" | "vegan" | "glutenFree" | "lactoseFree" | "other";

/** users/{uid}/meta/profile */
export interface UserProfile {
  name?: string;
  email?: string;
  age?: number;
  gender?: "male" | "female" | "other";
  height?: number;
  weight?: number;
  /** Multi-select — e.g. buildMuscle + loseWeight for body recomposition. */
  goals?: Goal[];
  activityLevel?: ActivityLevel;
  workoutTypes?: WorkoutType[];
  dietaryPrefs?: DietaryPref[];
  avoidFoods?: string[];
  allergies?: string[];
  preferredFoods?: string[];
  calorieGoal: number;
  proteinGoal: number;
  /** Percentage (0-100) of workout calories subtracted when computing net calories — default 50, since burn estimates run optimistic and a partial credit keeps the deficit conservative. */
  netCalorieBurnFactor?: number;
  /** Roughly how many steps/day the user currently walks — informational, set during onboarding. */
  averageDailySteps?: number;
  /** Daily steps goal, shown on Today and charted in History. */
  stepGoal?: number;
  /** grams; calculated during onboarding, editable manually afterward */
  carbGoal?: number;
  fatGoal?: number;
  showCarbs?: boolean;
  showFat?: boolean;
  showFiber?: boolean;
  language: "en" | "he";
  units: "metric" | "imperial";
  onboarded: boolean;
  createdAt: string;
  updatedAt: string;
}

/** users/{uid}/meta/memory */
export interface Memory {
  frequentFoods: Array<{ name: string; typicalPortionG?: number; typicalCalories?: number; typicalProtein?: number }>;
  mealTimes?: { breakfast?: string; lunch?: string; dinner?: string; snack?: string };
  workoutPatterns?: string;
  notes?: string;
  updatedAt: string;
}

/** users/{uid}/meta/alerts */
export interface Alerts {
  breakfastReminder: { enabled: boolean; time: string };
  lowCaloriesNoon: { enabled: boolean; thresholdPercent: number; checkTime: string };
  eveningSummary: { enabled: boolean; time: string };
  healthSync: { enabled: boolean; intervalHours: number };
}

export type ChatIntent =
  | "log_meal"
  | "log_workout"
  | "log_steps"
  | "query_history"
  | "general_health"
  | "manage_meal"
  | "out_of_scope";

/** Proposed edit/delete of an already-logged meal, awaiting user confirmation. */
export interface PendingMealAction {
  action: "delete" | "update";
  /** yyyy-mm-dd — the day the target entry lives in. */
  date: string;
  entryId: string;
  /** Human-readable name of the target entry, for the confirm UI. */
  entryName: string;
  /** Only present for action "update". */
  changes?: Partial<Pick<MealEntry, "name" | "calories" | "protein" | "carbs" | "fat" | "fiber">>;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  /** Present on an assistant message that's proposing meal(s) to log — not yet saved. `date` is the resolved target day (defaults to today, but a message like "add this for Monday" resolves elsewhere). */
  pendingMeal?: ParsedNutrition & { imageUrl?: string; date?: string };
  /** Present on an assistant message that's proposing an edit/delete of an existing meal. */
  pendingMealAction?: PendingMealAction;
  /** Present on an assistant message that's proposing a workout to log — not yet saved. */
  pendingWorkout?: ParsedWorkout & { imageUrl?: string; date: string };
  /** Present on an assistant message that's proposing a steps count to log — not yet saved. */
  pendingSteps?: { steps: number; date: string };
}

/** users/{uid}/chatSessions/{sessionId} */
export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

/** sharedChats/{shareId} — a public read-only snapshot of a ChatSession. */
export interface SharedChat {
  title: string;
  messages: ChatMessage[];
  sharedAt: string;
}

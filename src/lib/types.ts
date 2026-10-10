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
  /** grams — total sugars (estimate). New meals only; older entries don't have it. */
  sugar?: number;
  /** grams */
  saturatedFat?: number;
  /** milligrams */
  sodium?: number;
  /** True when sugar/saturatedFat/sodium/etc. are model-only guesses (no USDA/label/user-stated source). */
  nutrientsEstimated?: boolean;
  /** Estimated portion weight in grams, when known — used for USDA grounding and the frequent-meals picker. */
  grams?: number;
  /** Individual ingredients the user mentioned, when this entry is a composite dish (e.g. a salad) rather than a single named food — shown on expand. */
  ingredients?: string[];
  mealType?: "breakfast" | "lunch" | "dinner" | "snack";
  /** Where this came from, for auditing the parse. */
  source: "text" | "photo";
  /** Model confidence 0..1, when the parser provides one. */
  confidence?: number;
  confirmedAt: string;
  /**
   * How the calories/protein numbers were actually determined — shown on
   * expand so a logged entry isn't a black box. "manual" = typed directly
   * into a calories/protein field, no AI involved; "explicit" = stated in
   * free text ("...95 kcal") and used as-is; "usda"/"web" = grounded against
   * FoodData Central or a web-search fallback; "model" = the AI's own
   * estimate, nothing else matched.
   */
  nutritionSource?: "manual" | "explicit" | "usda" | "web" | "model";
  /** One-line, already-localized explanation of nutritionSource — e.g. which USDA entry matched and at what portion. */
  nutritionNote?: string;
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
  /** Apple's raw workout type (HealthKit), kept even when `type` is a friendlier label. Present for appleHealth workouts. */
  hkType?: string;
  /** Our category for the workout (profile workout types), derived from hkType / the typed name. */
  category?: WorkoutType;
  /** Recording device when known — "watch" or "phone". */
  device?: string;
  source: "appleHealth" | "manual";
  /** Stable id from the exporting app, used to dedupe re-imports (also the doc id). */
  externalId: string;
  syncedAt: string;
}

/** users/{uid}/steps/{date} — one doc per day (date = yyyy-mm-dd), last write wins. */
export interface DailySteps {
  date: string;
  steps: number;
  source: "manual" | "photo" | "appleHealth";
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
  sugar?: number;
  saturatedFat?: number;
  sodium?: number;
  nutrientsEstimated?: boolean;
  confidence?: number;
  /** Estimated portion weight in grams, when known. */
  grams?: number;
  /** Individual ingredients the user mentioned, when this item is a composite dish rather than a single named food. */
  ingredients?: string[];
  /** See MealEntry — carried through from parseNutrition so the confirm flow (chat + direct log) can persist it unchanged. */
  nutritionSource?: "manual" | "explicit" | "usda" | "web" | "model";
  nutritionNote?: string;
  /** Transient — not persisted to MealEntry. The venue name parseNutrition identified for this item, when a specific restaurant/place was named. */
  restaurantName?: string;
  /** Transient — not persisted to MealEntry. True when a restaurant was named but its actual menu/ingredients for this dish couldn't be found online, so the estimate falls back to a generic guess for that dish type — the chat reply uses this to invite the user to supply the real values if they know them. */
  restaurantMenuNotFound?: boolean;
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
export type DietStyle = "balanced" | "lowCarb" | "highProtein" | "mediterranean" | "keto" | "custom";
export interface NutrientTargets {
  carbsG: number;
  fatG: number;
  fiberG: number;
  sugarMaxG: number;
  satFatMaxG: number;
  sodiumMaxMg: number;
  source: "auto" | "manual";
}
export type DietaryPref = "everything" | "vegetarian" | "vegan" | "glutenFree" | "lactoseFree" | "other";

/** A user-defined daily goal template (e.g. "Drink water", "Read"), stored on the profile — tracked per-day in users/{uid}/dailyGoals/{date}. */
export interface CustomGoalDef {
  id: string;
  name: string;
  type: "boolean" | "numeric";
  /** "numeric" only — e.g. "cups", "pages". */
  unit?: string;
  /** "numeric" only — the day's entry counts as done once its value reaches this. */
  target?: number;
}

/** One custom goal's check-in for a single day. */
export interface DailyGoalEntry {
  goalId: string;
  done: boolean;
  /** "numeric" goals only — how much was actually done that day. */
  value?: number;
  note?: string;
}

/** users/{uid}/dailyGoals/{date} — one doc per day (date = yyyy-mm-dd). */
export interface DailyGoals {
  date: string;
  entries: DailyGoalEntry[];
}

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
  /** User-defined daily goals (water, reading, etc.), shown below Steps on Today — see CustomGoalDef. */
  customGoals?: CustomGoalDef[];
  /** Digits-only phone number (no "+") linked to this account for the WhatsApp bot — see whatsappLinks/{phone} for the reverse lookup. */
  whatsappPhone?: string;
  /** grams; calculated during onboarding, editable manually afterward */
  carbGoal?: number;
  fatGoal?: number;
  showCarbs?: boolean;
  showFat?: boolean;
  showFiber?: boolean;
  /** Daily water goal in millilitres (default derived from body weight, editable). */
  waterGoalMl?: number;
  /** Optional goal for the Progress screen: weight to reach and by when (yyyy-mm-dd). startWeightKg/targetSetAt are stamped when the target is saved. */
  targetWeightKg?: number;
  targetDate?: string;
  startWeightKg?: number;
  targetSetAt?: string;
  /** Daily insight / weekly review on WhatsApp — both default ON; set false to turn off. */
  insightPrefs?: { dailyInsightWhatsapp?: boolean; weeklyReviewWhatsapp?: boolean };
  /** Eating style the user chose — drives the automatic nutrient targets (src/lib/nutrition/nutrients.ts). */
  dietStyle?: DietStyle;
  /** Daily targets for the nutrient breakdown. "auto" values are recalculated from calories/weight/dietStyle; any manual edit flips source to "manual". */
  nutrientTargets?: NutrientTargets;
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

/** One proactive WhatsApp reminder type's config — "time" is HH:mm, Israel local time (the cron checks in 15-min buckets, see /api/cron/whatsapp-reminders). */
export interface ReminderConfig {
  enabled: boolean;
  time: string;
}

export type BuiltInReminderType =
  | "breakfastCheckIn"
  | "middayCheckIn"
  | "eveningSummary"
  | "morningRecap"
  | "weeklyWeighIn"
  | "customGoalsCheckIn";

/**
 * A free-form reminder the user asked for by name — via chat or WhatsApp
 * ("remind me every day at 8pm to drink water") — rather than one of the six
 * built-in types. `text` is sent verbatim as the WhatsApp message.
 */
export interface CustomReminder {
  id: string;
  text: string;
  time: string;
  recurrence: "daily" | "weekly";
  /** "weekly" only — 0=Sunday..6=Saturday, matching Date.getDay(). */
  weekday?: number;
  lastSent?: string;
  createdAt: string;
  /** What the user actually asked to be reminded of, in their words — the cron composes the delivered message from this plus the day's context, `text` is only the fallback. */
  intent?: string;
}

/**
 * whatsappReminders/{uid} — top-level, server-only (see firestore.rules), one
 * doc per user who has linked WhatsApp. Denormalizes phone/lang from the
 * profile so the cron can scan this single flat collection without joining
 * against users/{uid}/meta/profile for every row. `lastSent[type]` is a
 * yyyy-mm-dd used to dedupe — each reminder fires at most once per day.
 */
export interface WhatsAppReminderSettings {
  phone: string;
  lang: "en" | "he";
  /** No meals logged yet today by this time — a nudge to log breakfast. */
  breakfastCheckIn: ReminderConfig;
  /** Today's logged calories are still under thresholdPercent of the goal by this time. */
  middayCheckIn: ReminderConfig & { thresholdPercent: number };
  /** Today's totals vs goals, sent at the end of the day. */
  eveningSummary: ReminderConfig;
  /** Yesterday's totals vs goals, sent in the morning. */
  morningRecap: ReminderConfig;
  /** Sundays only — nudges a weigh-in if none logged yet today. */
  weeklyWeighIn: ReminderConfig;
  /** Any custom daily goals (see CustomGoalDef) not yet marked done today. */
  customGoalsCheckIn: ReminderConfig;
  /** User-defined reminders created via chat/WhatsApp — see CustomReminder. */
  customReminders?: CustomReminder[];
  lastSent: Partial<Record<BuiltInReminderType, string>>;
  updatedAt: string;
}

export type ChatIntent =
  | "log_meal"
  | "log_workout"
  | "log_steps"
  | "log_body_metrics"
  | "query_history"
  | "general_health"
  | "manage_meal"
  | "manage_reminder"
  | "out_of_scope";

/** A single weekly weigh-in's smart-scale readout — see src/lib/bodyMetrics/parser.ts. */
export interface ParsedBodyMetrics {
  weightKg?: number;
  bmi?: number;
  muscleMassKg?: number;
  bodyFatPercent?: number;
  visceralFat?: number;
  bodyWaterPercent?: number;
  basalMetabolicRate?: number;
  proteinPercent?: number;
}

/** users/{uid}/bodyMetrics/{date} — one doc per day a weigh-in was logged (date = yyyy-mm-dd). */
export interface BodyMetricsEntry extends ParsedBodyMetrics {
  date: string;
  confirmedAt: string;
}

/** Proposed edit/delete of an already-logged meal, awaiting user confirmation. */
export interface PendingMealAction {
  action: "delete" | "update";
  /** yyyy-mm-dd — the day the target entry lives in. */
  date: string;
  entryId: string;
  /** Human-readable name of the target entry, for the confirm UI. */
  entryName: string;
  /** Only present for action "update". */
  changes?: Partial<Pick<MealEntry, "name" | "calories" | "protein" | "carbs" | "fat" | "fiber" | "sugar" | "saturatedFat" | "sodium">>;
}

/**
 * Everything beyond "add a meal/workout/steps/weigh-in" that the chat can
 * do to the user's data — edits/deletes of saved entries and profile changes.
 * Proposed by the agent, applied only after the user confirms (WhatsApp 👍/"כן",
 * or the web Confirm button via /api/chat/apply-actions) — see
 * src/lib/chat/applyActions.ts.
 */
export type PendingAction =
  | { type: "workout_delete"; id: string; date: string; label: string }
  | {
      type: "workout_update";
      id: string;
      date: string;
      label: string;
      changes: { type?: string; duration?: number; distance?: number; calories?: number };
    }
  | { type: "steps_delete"; date: string; label: string }
  | { type: "body_metrics_delete"; date: string; label: string }
  | { type: "profile_update"; label: string; changes: Partial<UserProfile> };

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  /** WhatsApp message id (wamid) — lets a quote-reply or 👍 reaction on an old message be matched back to this one. */
  waId?: string;
  /** The proposal this message made, kept after a newer message took over the draft so a tap on its buttons can still confirm/cancel just its own part. */
  proposalSnapshot?: Pick<ChatMessage, "pendingMeal" | "pendingWorkout" | "pendingSteps" | "pendingBodyMetrics">;
  /** Set when this message's proposal was confirmed and saved (WhatsApp 👍/כן or web Confirm). Lets the agent's history show it's no longer a draft. */
  confirmedAt?: string;
  /** Present on an assistant message that's proposing meal(s) to log — not yet saved. `date` is the resolved target day (defaults to today, but a message like "add this for Monday" resolves elsewhere). */
  pendingMeal?: ParsedNutrition & { imageUrls?: string[]; date?: string };
  /** Present on an assistant message that's proposing an edit/delete of an existing meal. */
  pendingMealAction?: PendingMealAction;
  /** Present on an assistant message that's proposing a workout to log — not yet saved. */
  pendingWorkout?: ParsedWorkout & { imageUrls?: string[]; date: string };
  /** Present on an assistant message that's proposing a steps count to log — not yet saved. */
  pendingSteps?: { steps: number; date: string };
  /** Present on an assistant message that's proposing a weigh-in's readings to log — not yet saved. */
  pendingBodyMetrics?: ParsedBodyMetrics & { imageUrls?: string[]; date: string };
  /** Present on an assistant message proposing edits/deletes of saved workouts/steps/weigh-ins or profile changes — see PendingAction. */
  pendingActions?: PendingAction[];
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

/** users/{uid}/sleep/{date} — the night that ENDS on `date` (from Apple Health). */
export interface SleepNight {
  date: string;
  asleepMin: number;
  inBedMin?: number;
  syncedAt: string;
}

/** users/{uid}/vitals/{date} (from Apple Health). */
export interface VitalsDay {
  date: string;
  restingHr?: number;
  syncedAt: string;
}

/** users/{uid}/meta/healthSync — last Apple Health import, for display and for Lily. */
export interface HealthSyncMeta {
  lastSyncAt: string;
  workouts: number;
  sleepNights: number;
  stepDays: number;
  autoFilledAt?: string;
}

/** users/{uid}/dailyStats/{date} — nightly rollup (also refreshed on demand). */
export interface DailyStats {
  date: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  sugar: number;
  saturatedFat: number;
  sodium: number;
  /** Water drunk that day, millilitres. */
  waterMl?: number;
  mealsLogged: number;
  nutrientCoveredMeals: number;
  burned: number;
  netCalories: number;
  workoutCount: number;
  workoutMinutes: number;
  steps?: number;
  weightKg?: number;
  sleepAsleepMin?: number;
  restingHr?: number;
  computedAt: string;
}

/** users/{uid}/metrics/current — everything the Progress screen and the insight detectors read. */
export interface MetricsCurrent {
  computedAt: string;
  today: string;
  /** Days with at least 2 meals logged in the last 7 / 28 days. */
  logging: { days7: number; days28: number; streak: number };
  avg7: { calories: number; protein: number; net: number; steps?: number; sleepMin?: number };
  avg28: { calories: number; protein: number; net: number; steps?: number; sleepMin?: number };
  adherence: { calorieDays7: number; calorieDays28: number; proteinDays7: number; proteinDays28: number; loggedDays7: number; loggedDays28: number };
  weight?: {
    startKg?: number;
    latestKg: number;
    trendKg: number;
    /** kg per week, from a regression over the last 28 days of the smoothed trend. */
    weeklyRateKg?: number;
    series: { date: string; kg: number; trend: number }[];
    targetKg?: number;
    targetDate?: string;
    etaDate?: string;
    requiredDailyBalanceKcal?: number;
    /** What the logged balance predicts for the last 28 days vs what the scale shows. */
    expectedChange28Kg?: number;
    actualChange28Kg?: number;
    progressPct?: number;
    status: "ahead" | "onTrack" | "behind" | "notEnoughData";
  };
  workouts7: { count: number; minutes: number };
  workoutsPrev28: { perWeek: number };
  /** Number of days of data the screen can rely on. */
  daysWithData: number;
}

export type InsightType =
  | "proteinLow"
  | "restDayProtein"
  | "weekendGap"
  | "plateau"
  | "sodiumHigh"
  | "fiberLow"
  | "trainingDrop"
  | "sleepIntake"
  | "streak"
  | "aheadOfPlan"
  | "recalibrate"
  | "waterLow"
  | "weeklyReview";

/** users/{uid}/insights/{id} — a phrased insight shown on Today (and optionally sent on WhatsApp). */
export interface InsightText {
  title: string;
  body: string;
  actionLabel?: string;
  keepLabel?: string;
  prompt?: string;
}

export interface Insight {
  id: string;
  type: InsightType;
  kind: "daily" | "weekly";
  /** In the user's profile language (used where the UI language is unknown, e.g. WhatsApp fallback). */
  title: string;
  body: string;
  /** Both languages, so the app shows the insight in whichever language its UI is set to. */
  i18n?: { he: InsightText; en: InsightText };
  action?: { kind: "askLily"; label: string; prompt: string } | { kind: "applyCalorieGoal"; label: string; value: number; keepLabel: string };
  evidence: Record<string, number | string>;
  status: "new" | "shown" | "acted" | "dismissed";
  createdAt: string;
  expiresAt: string;
  /** yyyy-mm-dd the insight was generated for (Israel date). */
  date: string;
  whatsappSentAt?: string;
}

/** users/{uid}/water/{date} — one doc per day; `ml` is the running total. */
export interface WaterDay {
  date: string;
  ml: number;
  entries: { time: string; ml: number }[];
  updatedAt: string;
}

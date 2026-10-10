/**
 * The agent's tools. Design rule: the agent NEVER writes to the user's log.
 * Every "log/change" tool only edits the in-memory DRAFT for this turn; the
 * draft is attached to the reply as the usual pendingMeal/pendingWorkout/…
 * fields and is saved only when the user confirms (👍 / "כן" / the web
 * Confirm button) through the existing, unchanged confirm flows. The only
 * things tools write directly are reminders and the agent's own memory —
 * both explicit user requests.
 */
import "server-only";
import type OpenAI from "openai";
import { adminDb } from "@/lib/firebase/admin";
import { parseNutrition } from "@/lib/nutrition/parser";
import { parseWorkout } from "@/lib/workout/parser";
import { parseSteps } from "@/lib/steps/parser";
import { parseBodyMetrics } from "@/lib/bodyMetrics/parser";
import { lookupUsdaNutrients, webSearchNutrition } from "@/lib/nutrition/usda";
import { searchWeb } from "@/lib/chat/webSearch";
import { fetchRecentHistory } from "@/lib/chat/chat";
import { createCustomReminder, deleteCustomReminder, listCustomReminders } from "@/lib/reminders/manage";
import { strings } from "@/lib/i18n/strings";
import { addFact, logMistake, removeFact } from "./memory";
import type { AgentState, Draft } from "./state";
import { pickWritableProfile } from "@/lib/chat/applyActions";
import { fillMissingNutrients } from "@/lib/nutrition/extras";
import { addWater, undoLastWater } from "@/lib/water/server";
import { defaultWaterGoalMl } from "@/lib/water/water";
import type { ChatMessage, CustomGoalDef, CustomReminder, DailyGoalEntry, DailyGoals, MealDay, ParsedNutritionItem, PendingAction, UserProfile, WhatsAppReminderSettings, Workout } from "@/lib/types";

export interface TurnContext {
  uid: string;
  lang: "en" | "he";
  today: string;
  userMessage: string;
  imageUrls?: string[];
  priorMessages: ChatMessage[];
  state: AgentState;
  draft: Draft;
  /** Set when the agent called flag_mistake this turn — surfaced to evals. */
  mistakeFlagged?: boolean;
  /** Evals: tools that would write (reminders, memory, feedback log) only pretend to. */
  dryRun?: boolean;
}

type Tool = {
  def: OpenAI.Chat.Completions.ChatCompletionTool;
  run: (args: Record<string, unknown>, ctx: TurnContext) => Promise<unknown>;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function asDate(v: unknown, ctx: TurnContext): string {
  return typeof v === "string" && DATE_RE.test(v) && v <= ctx.today ? v : ctx.today;
}
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

function fn(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): OpenAI.Chat.Completions.ChatCompletionTool {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

const DATE_PROP = { type: "string", description: "yyyy-mm-dd. Resolve relative days (yesterday, Monday…) from NOW in the state block. Defaults to today." };

/** Sanity limits per workout type — a tool-side guard so a garbled number (e.g. a voice note's "50" heard as "5") never gets proposed as if it were real. */
function workoutWarnings(w: { type: string; durationSec: number; distanceMeters?: number; calories?: number }): string[] {
  const warnings: string[] = [];
  const minutes = w.durationSec / 60;
  const km = w.distanceMeters != null ? w.distanceMeters / 1000 : undefined;
  const t = w.type.toLowerCase();
  if (km != null && minutes > 0) {
    const kmh = km / (minutes / 60);
    const limit = /ride|cycl|bike|אופני|רכיב/.test(t) ? 60 : /run|ריצ|jog/.test(t) ? 24 : /walk|הליכ/.test(t) ? 9 : /swim|שחי/.test(t) ? 6 : 80;
    if (kmh > limit) warnings.push(`${km} km in ${Math.round(minutes)} min is ${Math.round(kmh)} km/h — not humanly plausible for ${w.type}.`);
  }
  if (w.calories != null && minutes > 0 && w.calories / minutes > 25) {
    warnings.push(`${Math.round(w.calories)} kcal in ${Math.round(minutes)} min is ${Math.round(w.calories / minutes)} kcal/min — implausibly high.`);
  }
  if (minutes > 0 && minutes < 3 && (km != null || (w.calories ?? 0) > 100)) {
    warnings.push(`Only ${Math.round(minutes)} min for those numbers looks like a mis-heard/mistyped duration.`);
  }
  return warnings;
}

function mealView(ctx: TurnContext) {
  const meal = ctx.draft.meal;
  return meal
    ? {
        date: meal.date ?? ctx.today,
        items: meal.items.map((it, i) => ({ index: i, description: it.description, calories: Math.round(it.calories), protein: Math.round(it.protein * 10) / 10 })),
        total_calories: Math.round(meal.items.reduce((a, i) => a + i.calories, 0)),
      }
    : null;
}

const logFood: Tool = {
  def: fn(
    "log_food",
    "Propose logging food/drink the user ate or drank (adds to the DRAFT — nothing is saved until the user confirms). Call once per distinct food (or once for several foods in one description). Write `description` in the user's own words including quantities and, if a restaurant/venue is involved, its name and city (resolve pronouns like 'their pizza' from the conversation yourself). The tool estimates calories/protein with real nutrition databases / menu search. Only pass calories/protein when the USER stated them for this food in their message.",
    {
      description: { type: "string", description: "What was eaten, in the user's words, with quantities. Self-contained — the tool sees no conversation." },
      name: { type: "string", description: "Optional display name for the entry. Default is derived from description. Use the user's own name for it (e.g. 'חצי משקה חלבון'), or the stored name of a regular food when matching one." },
      date: DATE_PROP,
      calories: { type: "number", description: "ONLY if the user stated total calories for this food." },
      protein: { type: "number", description: "ONLY if the user stated grams of protein for this food." },
      from_photo: { type: "boolean", description: "True when the food is in the photo(s) attached to the user's current message." },
    },
    ["description"],
  ),
  async run(args, ctx) {
    const description = str(args.description);
    if (!description) return { error: "description is required" };
    const date = asDate(args.date, ctx);
    if (ctx.draft.meal && (ctx.draft.meal.date ?? ctx.today) !== date) {
      return {
        error: "date_conflict",
        message: `The draft already holds meal items for ${ctx.draft.meal.date ?? ctx.today} and a draft can only carry one date. Tell the user those are still waiting for confirmation and ask whether to save them first (they confirm with 👍) or drop them — don't silently discard.`,
        draft: mealView(ctx),
      };
    }
    const calories = num(args.calories);
    const protein = num(args.protein);
    const name = str(args.name);

    // A regular food named exactly as stored (the model is told to use the stored name) takes its stored values — no re-estimation that can drift (108/16.9 instead of the usual 120/20).
    const regular = calories == null && protein == null && name ? ctx.state.frequentMeals.find((m) => norm(m.name) === norm(name)) : undefined;

    let items: ParsedNutritionItem[];
    if (regular) {
      items = [{ description: regular.name, calories: regular.calories, protein: regular.protein, ...(regular.grams != null ? { grams: regular.grams } : {}), nutritionSource: "explicit", nutritionNote: strings.nutritionSourceManual[ctx.lang] }];
    } else if (calories != null && protein != null) {
      items = [{ description: name ?? description, calories, protein, nutritionSource: "explicit", nutritionNote: strings.nutritionSourceManual[ctx.lang] }];
    } else {
      const text =
        description +
        (calories != null ? ` (${calories} ${ctx.lang === "he" ? "קלוריות" : "kcal"})` : "") +
        (protein != null ? ` (${protein}${ctx.lang === "he" ? " גרם חלבון" : "g protein"})` : "");
      const parsed = await parseNutrition({
        text,
        imageUrls: args.from_photo === true ? ctx.imageUrls : undefined,
        lang: ctx.lang,
        frequentMeals: ctx.state.frequentMeals,
      });
      items = parsed.items;
      if (name && items.length === 1) items = [{ ...items[0], description: name }];
    }

    items = await fillMissingNutrients(items);

    const existing = ctx.draft.meal?.items ?? [];
    const added: ParsedNutritionItem[] = [];
    const duplicates: string[] = [];
    for (const it of items) {
      if (existing.some((e) => norm(e.description) === norm(it.description) && Math.round(e.calories) === Math.round(it.calories))) {
        duplicates.push(it.description);
        continue;
      }
      added.push(it);
    }
    if (added.length) {
      ctx.draft.meal = {
        ...(ctx.draft.meal ?? { items: [] }),
        items: [...existing, ...added],
        date,
        ...(args.from_photo === true && ctx.imageUrls?.length ? { imageUrls: ctx.imageUrls } : {}),
      };
    }
    const savedSameName = ctx.state.meals
      .filter((d) => d.date === date)
      .flatMap((d) => d.entries)
      .filter((e) => added.some((a) => norm(a.description) === norm(e.name)))
      .map((e) => e.name);

    return {
      added: added.map((it) => ({
        description: it.description,
        calories: Math.round(it.calories),
        protein: Math.round(it.protein * 10) / 10,
        source: it.nutritionSource,
        ...(it.restaurantMenuNotFound
          ? { restaurant_menu_not_found: true, restaurant: it.restaurantName, assumed_ingredients: it.ingredients }
          : {}),
        ...(it.ingredients?.length && !it.restaurantMenuNotFound ? { ingredients: it.ingredients } : {}),
      })),
      ...(duplicates.length ? { skipped_duplicates_already_in_draft: duplicates } : {}),
      ...(savedSameName.length ? { note_same_name_already_saved_that_day: savedSameName } : {}),
      ...(((ctx.state.profile?.avoidFoods ?? []).filter((f) => added.some((a) => a.description.toLowerCase().includes(f.toLowerCase()))).length)
        ? { avoid_foods_hit: (ctx.state.profile?.avoidFoods ?? []).filter((f) => added.some((a) => a.description.toLowerCase().includes(f.toLowerCase()))) }
        : {}),
      draft: mealView(ctx),
    };
  },
};

const logWorkout: Tool = {
  def: fn(
    "log_workout",
    "Propose logging a workout (adds to the DRAFT, replacing any workout already in it). Describe it in the user's words; pass structured numbers whenever the user stated them. If the numbers are physically implausible the tool returns needs_clarification instead of drafting — then ask the user what they really meant (voice notes often garble numbers).",
    {
      description: { type: "string", description: "The workout in the user's words, self-contained." },
      type: { type: "string", description: "Workout type if clear (e.g. 'רכיבה על אופניים', 'אימון כוח', 'ריצה')." },
      duration_min: { type: "number" },
      distance_km: { type: "number" },
      calories: { type: "number", description: "ONLY if the user stated calories burned." },
      date: DATE_PROP,
      from_photo: { type: "boolean", description: "True when the workout is shown in the attached photo(s)." },
      confirmed_implausible: { type: "boolean", description: "Set true ONLY after the user explicitly confirmed numbers that looked implausible." },
    },
    ["description"],
  ),
  async run(args, ctx) {
    const description = str(args.description);
    if (!description && !(args.from_photo === true)) return { error: "description is required" };
    const parsed = await parseWorkout({ text: description, imageUrls: args.from_photo === true ? ctx.imageUrls : undefined, lang: ctx.lang });
    const w = {
      ...parsed,
      ...(str(args.type) ? { type: str(args.type)! } : {}),
      ...(num(args.duration_min) != null ? { durationSec: Math.round(num(args.duration_min)! * 60) } : {}),
      ...(num(args.distance_km) != null ? { distanceMeters: Math.round(num(args.distance_km)! * 1000) } : {}),
      ...(num(args.calories) != null ? { calories: num(args.calories) } : {}),
    };
    if (w.durationSec > 0 && w.distanceMeters != null && !("paceSecPerKm" in parsed && num(args.duration_min) == null)) {
      w.paceSecPerKm = Math.round(w.durationSec / (w.distanceMeters / 1000));
    }
    const warnings = workoutWarnings(w);
    if (warnings.length && args.confirmed_implausible !== true) {
      return { needs_clarification: true, warnings, parsed: { type: w.type, duration_min: Math.round(w.durationSec / 60), distance_km: w.distanceMeters != null ? w.distanceMeters / 1000 : undefined, calories: w.calories }, instruction: "Do NOT draft this. Ask the user which number is wrong, quoting what you understood." };
    }
    const replaced = ctx.draft.workout;
    ctx.draft.workout = { ...w, date: asDate(args.date, ctx), ...(args.from_photo === true && ctx.imageUrls?.length ? { imageUrls: ctx.imageUrls } : {}) };
    return {
      drafted: { type: w.type, duration_min: Math.round(w.durationSec / 60), distance_km: w.distanceMeters != null ? Math.round(w.distanceMeters / 100) / 10 : undefined, calories: w.calories != null ? Math.round(w.calories) : undefined, date: ctx.draft.workout.date },
      ...(replaced ? { replaced_previous_draft_workout: { type: replaced.type, duration_min: Math.round(replaced.durationSec / 60) } } : {}),
    };
  },
};

const logSteps: Tool = {
  def: fn("log_steps", "Propose logging a day's step count (DRAFT only).", {
    steps: { type: "number" },
    date: DATE_PROP,
    from_photo: { type: "boolean" },
  }),
  async run(args, ctx) {
    let steps = num(args.steps);
    if (steps == null) {
      const parsed = await parseSteps({ text: ctx.userMessage || undefined, imageUrls: ctx.imageUrls });
      steps = parsed.steps;
    }
    ctx.draft.steps = { steps: Math.round(steps), date: asDate(args.date, ctx) };
    return { drafted: ctx.draft.steps };
  },
};

const logBodyMetrics: Tool = {
  def: fn("log_body_metrics", "Propose logging a smart-scale weigh-in read from the attached photo(s) or stated in text (DRAFT only).", {
    date: DATE_PROP,
  }),
  async run(args, ctx) {
    const parsed = await parseBodyMetrics({ text: ctx.userMessage || undefined, imageUrls: ctx.imageUrls });
    if (Object.keys(parsed).length === 0) return { error: "Couldn't read any body metrics from this message/photo." };
    ctx.draft.bodyMetrics = { ...parsed, date: asDate(args.date, ctx), ...(ctx.imageUrls?.length ? { imageUrls: ctx.imageUrls } : {}) };
    return { drafted: parsed, date: ctx.draft.bodyMetrics.date };
  },
};

const updateDraft: Tool = {
  def: fn(
    "update_draft",
    "Change something in the DRAFT (only what is listed under DRAFT in the current state — if the DRAFT is empty or lacks that item, this is the WRONG tool: for an already-SAVED entry use change_logged_meal / change_logged_workout / delete_logged_*). A meal item's name/numbers, the workout's duration/distance/calories/type, the steps, or the date of a whole kind. Use this for corrections ('it was 55 minutes', 'make it 300 calories', 'put it on yesterday').",
    {
      kind: { type: "string", enum: ["meal", "workout", "steps", "body_metrics"] },
      item_index: { type: "number", description: "Meal only: which item (#index from the draft)." },
      name: { type: "string" },
      calories: { type: "number" },
      protein: { type: "number" },
      duration_min: { type: "number" },
      distance_km: { type: "number" },
      steps: { type: "number" },
      type: { type: "string", description: "Workout type name." },
      date: DATE_PROP,
    },
    ["kind"],
  ),
  async run(args, ctx) {
    const d = ctx.draft;
    const date = typeof args.date === "string" && DATE_RE.test(args.date) && args.date <= ctx.today ? args.date : undefined;
    if (args.kind === "meal") {
      if (!d.meal) return { error: "There is no meal in the draft." };
      const idx = num(args.item_index);
      if (idx != null) {
        const it = d.meal.items[idx];
        if (!it) return { error: `No meal item #${idx} in the draft.` };
        d.meal.items[idx] = {
          ...it,
          ...(str(args.name) ? { description: str(args.name)! } : {}),
          ...(num(args.calories) != null ? { calories: num(args.calories)! } : {}),
          ...(num(args.protein) != null ? { protein: num(args.protein)! } : {}),
          ...(num(args.calories) != null || num(args.protein) != null
            ? { nutritionSource: "manual" as const, nutritionNote: strings.nutritionSourceAdjusted[ctx.lang] }
            : {}),
        };
      }
      if (date) d.meal.date = date;
      return { draft: mealView(ctx) };
    }
    if (args.kind === "workout") {
      if (!d.workout) return { error: "There is no workout in the draft." };
      d.workout = {
        ...d.workout,
        ...(str(args.type) ? { type: str(args.type)! } : {}),
        ...(num(args.duration_min) != null ? { durationSec: Math.round(num(args.duration_min)! * 60) } : {}),
        ...(num(args.distance_km) != null ? { distanceMeters: Math.round(num(args.distance_km)! * 1000) } : {}),
        ...(num(args.calories) != null ? { calories: num(args.calories)! } : {}),
        ...(date ? { date } : {}),
      };
      const warnings = workoutWarnings(d.workout);
      return { draft_workout: { type: d.workout.type, duration_min: Math.round(d.workout.durationSec / 60), distance_km: d.workout.distanceMeters != null ? d.workout.distanceMeters / 1000 : undefined, calories: d.workout.calories, date: d.workout.date }, ...(warnings.length ? { warnings, instruction: "These numbers still look implausible — ask the user." } : {}) };
    }
    if (args.kind === "steps") {
      if (!d.steps) return { error: "There are no steps in the draft." };
      d.steps = { ...d.steps, ...(num(args.steps) != null ? { steps: Math.round(num(args.steps)!) } : {}), ...(date ? { date } : {}) };
      return { draft_steps: d.steps };
    }
    if (!d.bodyMetrics) return { error: "There are no body metrics in the draft." };
    if (date) d.bodyMetrics = { ...d.bodyMetrics, date };
    return { draft_body_metrics: d.bodyMetrics };
  },
};

const removeFromDraft: Tool = {
  def: fn(
    "remove_from_draft",
    "Remove something from the DRAFT: one meal item (item_index) or a whole kind (omit item_index). Use for 'only the workout', 'forget the beer', 'cancel that'. kind 'all' empties the draft.",
    {
      kind: { type: "string", enum: ["meal", "workout", "steps", "body_metrics", "meal_action", "actions", "all"] },
      item_index: { type: "number" },
    },
    ["kind"],
  ),
  async run(args, ctx) {
    const d = ctx.draft;
    const kind = args.kind;
    if (kind === "all") {
      ctx.draft = {};
      return { draft: "empty" };
    }
    if (kind === "meal") {
      if (!d.meal) return { error: "There is no meal in the draft." };
      const idx = num(args.item_index);
      if (idx != null) {
        if (!d.meal.items[idx]) return { error: `No meal item #${idx}.` };
        d.meal.items.splice(idx, 1);
        if (d.meal.items.length === 0) delete d.meal;
      } else delete d.meal;
      return { draft: mealView(ctx) ?? "no meal in draft" };
    }
    if (kind === "workout") delete d.workout;
    else if (kind === "steps") delete d.steps;
    else if (kind === "body_metrics") delete d.bodyMetrics;
    else if (kind === "meal_action") delete d.mealAction;
    else if (kind === "actions") {
      const idx = num(args.item_index);
      if (idx != null && d.actions?.[idx]) d.actions.splice(idx, 1);
      else delete d.actions;
      if (d.actions && d.actions.length === 0) delete d.actions;
    }
    return { removed: kind, draft_empty: !(d.meal || d.workout || d.steps || d.bodyMetrics || d.mealAction || d.actions?.length) };
  },
};

async function mealDay(uid: string, date: string): Promise<MealDay | undefined> {
  return (await adminDb.collection("users").doc(uid).collection("meals").doc(date).get()).data() as MealDay | undefined;
}

const findLogged: Tool = {
  def: fn(
    "find_logged",
    "Look up what is ALREADY SAVED in the user's log (with entry ids) for a date range — meals, workouts, steps, weigh-ins (body metrics) and custom daily-goal check-ins. The state block already lists the last 3 days; use this for older days or to double-check before editing/deleting.",
    {
      date_from: DATE_PROP,
      date_to: DATE_PROP,
      query: { type: "string", description: "Optional name filter for meals." },
    },
  ),
  async run(args, ctx) {
    const to = asDate(args.date_to, ctx);
    const fromRaw = typeof args.date_from === "string" && DATE_RE.test(args.date_from) ? args.date_from : to;
    const from = fromRaw > to ? to : fromRaw;
    const dayCount = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
    if (dayCount > 31) return { error: "Range too large — at most 31 days." };
    const q = str(args.query)?.toLowerCase();
    const days: unknown[] = [];
    for (let i = 0; i < dayCount; i++) {
      const date = new Date(Date.parse(from) + i * 86_400_000).toISOString().slice(0, 10);
      const day = await mealDay(ctx.uid, date);
      const entries = (day?.entries ?? []).filter((e) => !q || e.name.toLowerCase().includes(q));
      if (entries.length) days.push({ date, entries: entries.map((e) => ({ id: e.id, name: e.name, calories: Math.round(e.calories), protein: Math.round(e.protein * 10) / 10 })) });
    }
    const u = adminDb.collection("users").doc(ctx.uid);
    const [wSnap, stSnap, bSnap, gSnap] = await Promise.all([
      u.collection("workouts").where("date", ">=", from).where("date", "<=", to).get(),
      u.collection("steps").where("date", ">=", from).where("date", "<=", to).get(),
      u.collection("bodyMetrics").where("date", ">=", from).where("date", "<=", to).get(),
      u.collection("dailyGoals").where("date", ">=", from).where("date", "<=", to).get(),
    ]);
    const workouts = wSnap.docs.map((d) => d.data() as Workout).map((w) => ({ id: w.id, date: w.date, type: w.type, duration_min: Math.round(w.duration / 60), distance_km: w.distance != null ? w.distance / 1000 : undefined, calories: w.calories }));
    return {
      meals: days,
      workouts,
      steps: stSnap.docs.map((d) => d.data() as { date: string; steps: number }).map((x) => ({ date: x.date, steps: x.steps })),
      body_metrics: bSnap.docs.map((d) => d.data()),
      daily_goal_checkins: gSnap.docs.map((d) => d.data()),
    };
  },
};

const changeLoggedMeal: Tool = {
  def: fn(
    "change_logged_meal",
    "Propose deleting or editing a meal entry that is ALREADY SAVED (goes into the DRAFT as a proposal — the user confirms). Use ONLY when the user explicitly wants an existing saved entry changed/removed — never to add food. entry_id and date must come from the ALREADY SAVED list / find_logged; match the day the user named. One entry per turn.",
    {
      entry_id: { type: "string" },
      date: { type: "string", description: "yyyy-mm-dd of the day the saved entry lives in." },
      action: { type: "string", enum: ["delete", "update"] },
      name: { type: "string" },
      calories: { type: "number" },
      protein: { type: "number" },
    },
    ["entry_id", "date", "action"],
  ),
  async run(args, ctx) {
    const entryId = str(args.entry_id);
    const date = typeof args.date === "string" && DATE_RE.test(args.date) ? args.date : undefined;
    if (!entryId || !date) return { error: "entry_id and a valid date are required." };
    const fromState = ctx.state.meals.find((d) => d.date === date)?.entries.find((e) => e.id === entryId);
    const entry = fromState ?? (await mealDay(ctx.uid, date))?.entries.find((e) => e.id === entryId);
    if (!entry) return { error: `No saved entry with id ${entryId} on ${date}. Check the ALREADY SAVED list or call find_logged.` };
    if (args.action === "delete") {
      ctx.draft.mealAction = { action: "delete", date, entryId, entryName: entry.name };
    } else {
      const changes = {
        ...(str(args.name) ? { name: str(args.name)! } : {}),
        ...(num(args.calories) != null ? { calories: num(args.calories)! } : {}),
        ...(num(args.protein) != null ? { protein: num(args.protein)! } : {}),
      };
      if (Object.keys(changes).length === 0) return { error: "Nothing to change — pass name, calories or protein." };
      ctx.draft.mealAction = { action: "update", date, entryId, entryName: entry.name, changes };
    }
    return { proposed: ctx.draft.mealAction };
  },
};

const getHistory: Tool = {
  def: fn("get_history", "Per-day totals (calories, protein, net after workouts), workouts and steps for the last N days — for questions about progress, patterns, 'how did I do last week'. Up to 90 days.", {
    days: { type: "number", description: "How many days back (default 14, max 90)." },
  }),
  async run(args, ctx) {
    const days = Math.min(Math.max(Math.round(num(args.days) ?? 14), 1), 90);
    const h = await fetchRecentHistory(ctx.uid, days);
    return { meals: h.meals, workouts: h.workouts, steps: h.steps, calorie_goal: h.calorieGoal, net_calorie_burn_factor_percent: h.netCalorieBurnFactor, note: "meals[].netCalories already applies the burn factor; exceededGoal is precomputed — use it, don't recompute." };
  },
};

const lookupNutrition: Tool = {
  def: fn("lookup_nutrition", "Verified calories/protein per 100g for a food from USDA (falls back to web). Use when answering a nutrition QUESTION with a specific number. (To log food use log_food, which does this itself.)", {
    food: { type: "string", description: "Specific English food name incl. preparation, e.g. 'white rice, cooked'." },
  }, ["food"]),
  async run(args) {
    const food = str(args.food);
    if (!food) return { error: "food is required" };
    return (await lookupUsdaNutrients(food)) ?? (await webSearchNutrition(food)) ?? { error: "No reliable match from USDA or the web." };
  },
};

const searchWebTool: Tool = {
  def: fn("search_web", "Search the web for a real-world fact (a restaurant's menu, a branded product, anything current). Use short plain queries like '[place] [city] menu'; prefer English; never add words like 'nutrition facts'. Returns text or null.", {
    query: { type: "string" },
  }, ["query"]),
  async run(args) {
    const q = str(args.query);
    if (!q) return { error: "query is required" };
    return (await searchWeb(q)) ?? "No reliable result found for this search.";
  },
};

const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  breakfastCheckIn: "Nudge if no meal has been logged yet today (skipped when something is already logged).",
  middayCheckIn: "Nudge if calories logged so far are below a threshold % of the daily goal.",
  eveningSummary: "Today's totals: calories, protein, steps, workouts, plus the net balance left (calories and protein).",
  morningRecap: "Yesterday's totals: calories, protein, steps, workouts.",
  weeklyWeighIn: "Sunday nudge to weigh in and send a scale screenshot (skipped if already logged).",
  customGoalsCheckIn: "Lists the custom daily goals not ticked yet today (skipped if all done).",
};

async function listAllReminders(uid: string) {
  const r = (await adminDb.collection("whatsappReminders").doc(uid).get()).data() as Record<string, any> | undefined;
  const builtin = Object.entries(BUILTIN_DESCRIPTIONS).map(([type, what_it_sends]) => {
    const c = r?.[type] as { enabled?: boolean; time?: string; thresholdPercent?: number } | undefined;
    return { type, enabled: !!c?.enabled, time: c?.time ?? null, ...(type === "middayCheckIn" && c?.thresholdPercent != null ? { threshold_percent: c.thresholdPercent } : {}), what_it_sends, last_sent: r?.lastSent?.[type] ?? null };
  });
  const custom = ((r?.customReminders ?? []) as CustomReminder[]).map((c) => ({
    id: c.id,
    what_it_is_about: c.intent ?? c.text,
    fallback_text: c.text,
    time: c.time,
    recurrence: c.recurrence,
    weekday: c.weekday,
    note: "The message is re-written fresh each time from today's real numbers (calories left, protein left, meals logged…).",
    last_sent: c.lastSent ?? null,
  }));
  return { builtin_reminders: builtin, custom_reminders: custom };
}

const manageReminders: Tool = {
  def: fn(
    "manage_reminders",
    "Create, list, update or delete the user's recurring WhatsApp reminders. `list` returns EVERYTHING that can message them — the app's built-in check-ins (on/off, time, what each sends) AND their custom reminders — use it for any 'what reminders do I have / what does the 22:00 one say / what is X' question and explain each in plain words. To CHANGE an existing custom reminder (time, wording, what it should include) use `update` — never delete+create. Built-in ones are changed with set_builtin_reminder. When creating, `message` is the text that will be sent — write it yourself in Lilly's warm voice, fitted to the request (don't copy their wording verbatim; make it friendly, specific and human, one or two short sentences, may include one emoji). `intent` is a short plain description of what they asked to be reminded of (used later to compose the day's message with real context).",
    {
      action: { type: "string", enum: ["create", "list", "update", "delete"] },
      intent: { type: "string", description: "create/update: what the user asked to be reminded of, plain." },
      message: { type: "string", description: "create: the friendly fallback message text." },
      time: { type: "string", description: "create: HH:mm 24h, Israel time." },
      recurrence: { type: "string", enum: ["daily", "weekly"] },
      weekday: { type: "number", description: "weekly only, 0=Sunday..6=Saturday." },
      match: { type: "string", description: "delete: reminder id or a phrase identifying it." },
    },
    ["action"],
  ),
  async run(args, ctx) {
    if (args.action === "list") return listAllReminders(ctx.uid);
    if (args.action === "update") {
      const match = str(args.match);
      if (!match) return { error: "match is required (id or phrase)" };
      const time = str(args.time);
      if (time && !/^\d{2}:\d{2}$/.test(time)) return { error: "time must be HH:mm" };
      const ref = adminDb.collection("whatsappReminders").doc(ctx.uid);
      const settings = (await ref.get()).data() as { customReminders?: CustomReminder[] } | undefined;
      const list = settings?.customReminders ?? [];
      const needle = match.toLowerCase();
      const hit = list.find((r) => r.id === match) ?? list.find((r) => `${r.intent ?? ""} ${r.text} ${r.time}`.toLowerCase().includes(needle));
      if (!hit) return { error: "No custom reminder matched." };
      const updated = { ...hit, ...(time ? { time } : {}), ...(str(args.message) ? { text: str(args.message)! } : {}), ...(str(args.intent) ? { intent: str(args.intent)! } : {}), ...(args.recurrence ? { recurrence: args.recurrence === "weekly" ? "weekly" : "daily" } : {}), ...(num(args.weekday) != null ? { weekday: num(args.weekday) } : {}), ...(time && time !== hit.time ? { lastSent: undefined, createdAt: new Date().toISOString() } : {}) } as CustomReminder;
      if (ctx.dryRun) return { updated };
      await ref.set({ customReminders: list.map((r) => (r.id === hit.id ? JSON.parse(JSON.stringify(updated)) : r)) }, { merge: true });
      return { updated: { id: updated.id, intent: updated.intent ?? updated.text, time: updated.time, recurrence: updated.recurrence } };
    }
    if (args.action === "delete") {
      const match = str(args.match);
      if (!match) return { error: "match is required" };
      if (ctx.dryRun) return { deleted: { id: "dry", intent: match } };
      const removed = await deleteCustomReminder(ctx.uid, match);
      return removed ? { deleted: { id: removed.id, intent: removed.intent ?? removed.text, time: removed.time } } : { error: "No reminder matched." };
    }
    const time = str(args.time);
    const message = str(args.message);
    const intent = str(args.intent);
    if (!time || !/^\d{2}:\d{2}$/.test(time) || !message || !intent) return { error: "create needs intent, message and time (HH:mm)." };
    const recurrence = args.recurrence === "weekly" ? "weekly" : "daily";
    if (ctx.dryRun) return { created: { id: "dry", time, recurrence, message, intent } };
    const res = await createCustomReminder(ctx.uid, { text: message, intent, time, recurrence, weekday: num(args.weekday), lang: ctx.lang });
    return res.ok ? { created: { id: res.reminder.id, time, recurrence, weekday: res.reminder.weekday } } : { error: res.error };
  },
};

const logWater: Tool = {
  def: fn("log_water", "Save water the user drank — saved IMMEDIATELY (no draft or confirmation needed: it is small and easy to undo). Convert what they said to millilitres (a glass/כוס = 250, a bottle/בקבוק = 500 unless they say the size, a litre = 1000). Use negative-free amounts only; to take back the last one use undo.", {
    ml: { type: "number", description: "Millilitres to add (omit when undo is true)." },
    undo: { type: "boolean", description: "True to remove the last water entry instead of adding." },
    date: { type: "string", description: "yyyy-mm-dd; defaults to today." },
  }),
  async run(args, ctx) {
    const date = str(args.date) ?? ctx.state.today;
    if (args.undo === true) {
      if (ctx.dryRun) return { undone: true, dryRun: true };
      const day = await undoLastWater(ctx.uid, date);
      return day ? { undone: true, totalMl: day.ml, goalMl: ctx.state.profile?.waterGoalMl ?? defaultWaterGoalMl(ctx.state.profile?.weight) } : { error: "No water entries to undo." };
    }
    const ml = num(args.ml);
    if (ml == null || ml <= 0 || ml > 5000) return { error: "ml must be between 1 and 5000." };
    if (ctx.dryRun) return { added: { ml }, totalMl: ml, dryRun: true };
    const day = await addWater(ctx.uid, date, ml);
    return { added: { ml }, totalMl: day.ml, goalMl: ctx.state.profile?.waterGoalMl ?? defaultWaterGoalMl(ctx.state.profile?.weight) };
  },
};

const remember: Tool = {
  def: fn("remember", "Save a short durable fact about the user for future conversations (a preference, a regular food's values, a constraint, a correction they gave you). Not for one-off trivia or anything already in the profile/log.", {
    fact: { type: "string", description: "One short sentence, in the user's language." },
  }, ["fact"]),
  async run(args, ctx) {
    const fact = str(args.fact);
    if (!fact) return { error: "fact is required" };
    if (ctx.dryRun) return { saved: { id: "dry", text: fact } };
    const f = await addFact(ctx.uid, fact);
    return { saved: f };
  },
};

const forget: Tool = {
  def: fn("forget", "Delete a saved memory fact (by id from LONG-TERM MEMORY, or a phrase from it) when the user says it's wrong or asks you to forget it.", {
    fact: { type: "string" },
  }, ["fact"]),
  async run(args, ctx) {
    const fact = str(args.fact);
    if (!fact) return { error: "fact is required" };
    if (ctx.dryRun) return { forgotten: { id: "dry", text: fact } };
    const removed = await removeFact(ctx.uid, fact);
    return removed ? { forgotten: removed } : { error: "No matching fact." };
  },
};

const flagMistake: Tool = {
  def: fn("flag_mistake", "Call this IMMEDIATELY whenever the user signals you got something wrong or misunderstood them — 'את טועה', 'זה לא נכון', 'לא הבנת', 'שימי לב', 'אמרתי X', repeating themselves, correcting a number. It records the failure for review. Afterwards you must still fix the problem for real.", {
    what_went_wrong: { type: "string", description: "Your honest diagnosis of what the user is pointing at (e.g. 'I logged 5 minutes though they said 55')." },
  }, ["what_went_wrong"]),
  async run(args, ctx) {
    ctx.mistakeFlagged = true;
    const lastAssistant = [...ctx.priorMessages].reverse().find((m) => m.role === "assistant");
    if (!ctx.dryRun) await logMistake(ctx.uid, { userMessage: ctx.userMessage, lastAssistantMessage: lastAssistant?.content, note: str(args.what_went_wrong) ?? "" }).catch(() => {});
    return { recorded: true, next: "Re-read the user's last messages literally, find the exact discrepancy, fix it with tools, and in your reply say specifically what you got wrong and what you changed. Do not repeat your previous reply." };
  },
};


function ownLabel(ctx: TurnContext, he: string, en: string) {
  return ctx.lang === "he" ? he : en;
}

function addAction(ctx: TurnContext, action: PendingAction) {
  const key = (a: PendingAction) => `${a.type}:${"id" in a ? a.id : "date" in a ? a.date : ""}`;
  ctx.draft.actions = [...(ctx.draft.actions ?? []).filter((a) => key(a) !== key(action)), action];
}

const changeLoggedWorkout: Tool = {
  def: fn(
    "change_logged_workout",
    "Propose deleting or editing a workout that is ALREADY SAVED (goes to the DRAFT; the user confirms). id comes from the ALREADY SAVED list / find_logged. Use only when the user explicitly wants an existing saved workout changed/removed — to add a new one use log_workout.",
    {
      id: { type: "string" },
      action: { type: "string", enum: ["delete", "update"] },
      type: { type: "string" },
      duration_min: { type: "number" },
      distance_km: { type: "number" },
      calories: { type: "number" },
    },
    ["id", "action"],
  ),
  async run(args, ctx) {
    const id = str(args.id);
    if (!id) return { error: "id is required" };
    const fromState = ctx.state.workouts.find((x) => x.id === id);
    const snap = fromState ? null : await adminDb.collection("users").doc(ctx.uid).collection("workouts").doc(id).get();
    if (!fromState && !snap?.exists) return { error: `No saved workout with id ${id}. Check the ALREADY SAVED list or find_logged.` };
    const w = (fromState ? { type: fromState.type, date: fromState.date, duration: fromState.durationMin * 60, distance: fromState.distanceKm != null ? fromState.distanceKm * 1000 : undefined, calories: fromState.calories } : snap!.data()) as Workout;
    const name = `${w.type} (${w.date}, ${Math.round(w.duration / 60)} min)`;
    if (args.action === "delete") {
      addAction(ctx, { type: "workout_delete", id, date: w.date, label: ownLabel(ctx, `מחיקת האימון ${name}`, `delete workout ${name}`) });
      return { proposed: `delete workout ${name}` };
    }
    const changes = {
      ...(str(args.type) ? { type: str(args.type)! } : {}),
      ...(num(args.duration_min) != null ? { duration: Math.round(num(args.duration_min)! * 60) } : {}),
      ...(num(args.distance_km) != null ? { distance: Math.round(num(args.distance_km)! * 1000) } : {}),
      ...(num(args.calories) != null ? { calories: num(args.calories)! } : {}),
    };
    if (!Object.keys(changes).length) return { error: "Nothing to change — pass type, duration_min, distance_km or calories." };
    const merged = { type: changes.type ?? w.type, durationSec: changes.duration ?? w.duration, distanceMeters: changes.distance ?? w.distance, calories: changes.calories ?? w.calories };
    const warnings = workoutWarnings(merged);
    if (warnings.length) return { needs_clarification: true, warnings, instruction: "Do NOT propose this. Ask the user which number they really meant." };
    addAction(ctx, { type: "workout_update", id, date: w.date, changes, label: ownLabel(ctx, `עדכון האימון ${name}`, `update workout ${name}`) });
    return { proposed: { update_workout: name, changes } };
  },
};

const deleteLoggedSteps: Tool = {
  def: fn("delete_logged_steps", "Propose deleting the saved step count of a day (DRAFT; the user confirms). To CHANGE a day's steps use log_steps instead.", { date: DATE_PROP }),
  async run(args, ctx) {
    const date = asDate(args.date, ctx);
    const snap = await adminDb.collection("users").doc(ctx.uid).collection("steps").doc(date).get();
    if (!snap.exists && !ctx.dryRun) return { error: `No saved steps on ${date}.` };
    addAction(ctx, { type: "steps_delete", date, label: ownLabel(ctx, `מחיקת הצעדים של ${date}`, `delete steps of ${date}`) });
    return { proposed: `delete steps of ${date}`, current: (snap.data() as { steps?: number } | undefined)?.steps };
  },
};

const deleteLoggedBodyMetrics: Tool = {
  def: fn("delete_logged_body_metrics", "Propose deleting a saved weigh-in (body metrics) of a day (DRAFT; the user confirms).", { date: DATE_PROP }),
  async run(args, ctx) {
    const date = asDate(args.date, ctx);
    const snap = await adminDb.collection("users").doc(ctx.uid).collection("bodyMetrics").doc(date).get();
    if (!snap.exists && !ctx.dryRun) return { error: `No saved weigh-in on ${date}.` };
    addAction(ctx, { type: "body_metrics_delete", date, label: ownLabel(ctx, `מחיקת השקילה של ${date}`, `delete weigh-in of ${date}`) });
    return { proposed: `delete weigh-in of ${date}` };
  },
};

const GOALS = ["buildMuscle", "cut", "loseWeight", "maintain"];
const ACTIVITY = ["sedentary", "light", "moderate", "intense", "veryIntense"];
const DIETS = ["everything", "vegetarian", "vegan", "glutenFree", "lactoseFree", "other"];

const updateProfile: Tool = {
  def: fn(
    "update_profile",
    "Propose changing the user's profile/goals (DRAFT; the user confirms): daily calorie/protein/carb/fat/step goals, body stats, goal types, activity level, dietary preferences, foods to avoid/allergies/preferred foods, the % of workout calories counted toward the net deficit, display name/units/language. Pass only the fields that change.",
    {
      calorie_goal: { type: "number" },
      protein_goal: { type: "number" },
      carb_goal: { type: "number" },
      fat_goal: { type: "number" },
      step_goal: { type: "number" },
      weight_kg: { type: "number" },
      height_cm: { type: "number" },
      age: { type: "number" },
      name: { type: "string" },
      goals: { type: "array", items: { type: "string", enum: GOALS }, description: "buildMuscle | cut | loseWeight | maintain" },
      activity_level: { type: "string", enum: ACTIVITY },
      dietary_prefs: { type: "array", items: { type: "string", enum: DIETS } },
      avoid_foods: { type: "array", items: { type: "string" } },
      allergies: { type: "array", items: { type: "string" } },
      preferred_foods: { type: "array", items: { type: "string" } },
      net_calorie_burn_percent: { type: "number", description: "0-100: share of workout calories subtracted when computing net calories." },
      units: { type: "string", enum: ["metric", "imperial"] },
      language: { type: "string", enum: ["en", "he"] },
    },
  ),
  async run(args, ctx) {
    const map: Record<string, string> = {
      calorie_goal: "calorieGoal", protein_goal: "proteinGoal", carb_goal: "carbGoal", fat_goal: "fatGoal", step_goal: "stepGoal",
      weight_kg: "weight", height_cm: "height", age: "age", name: "name", goals: "goals", activity_level: "activityLevel",
      dietary_prefs: "dietaryPrefs", avoid_foods: "avoidFoods", allergies: "allergies", preferred_foods: "preferredFoods",
      net_calorie_burn_percent: "netCalorieBurnFactor", units: "units", language: "language",
    };
    const changes: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) if (map[k] && v !== undefined && v !== null) changes[map[k]] = v;
    const writable = pickWritableProfile(changes);
    if (!Object.keys(writable).length) return { error: "No valid field to change." };
    const prev = ctx.draft.actions?.find((a) => a.type === "profile_update");
    const merged = { ...(prev?.type === "profile_update" ? prev.changes : {}), ...writable } as Partial<UserProfile>;
    ctx.draft.actions = [...(ctx.draft.actions ?? []).filter((a) => a.type !== "profile_update"), { type: "profile_update", changes: merged, label: ownLabel(ctx, `עדכון פרופיל: ${Object.keys(merged).join(", ")}`, `update profile: ${Object.keys(merged).join(", ")}`) }];
    const current = ctx.state.profile as Record<string, unknown> | undefined;
    return { proposed_changes: Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, { from: current?.[k], to: v }])) };
  },
};

const manageCustomGoals: Tool = {
  def: fn(
    "manage_custom_goals",
    "The user's custom daily goals (e.g. 'drink water', 'read'): list them, or propose adding/removing one (DRAFT; the user confirms). To mark a goal done/progress for a day use set_daily_goal.",
    {
      action: { type: "string", enum: ["list", "add", "remove"] },
      name: { type: "string" },
      type: { type: "string", enum: ["boolean", "numeric"] },
      unit: { type: "string", description: "numeric only, e.g. 'כוסות'." },
      target: { type: "number", description: "numeric only: value at which the day counts as done." },
    },
    ["action"],
  ),
  async run(args, ctx) {
    const defs: CustomGoalDef[] = (ctx.state.profile?.customGoals ?? []) as CustomGoalDef[];
    if (args.action === "list") return { custom_goals: defs };
    const name = str(args.name);
    if (!name) return { error: "name is required" };
    if (args.action === "remove") {
      const g = defs.find((d) => d.name.toLowerCase() === name.toLowerCase() || d.id === name) ?? defs.find((d) => d.name.toLowerCase().includes(name.toLowerCase()));
      if (!g) return { error: "No such custom goal.", existing: defs.map((d) => d.name) };
      const next = defs.filter((d) => d.id !== g.id);
      ctx.draft.actions = [...(ctx.draft.actions ?? []).filter((a) => a.type !== "profile_update"), { type: "profile_update", changes: { customGoals: next }, label: ownLabel(ctx, `הסרת היעד היומי "${g.name}"`, `remove daily goal "${g.name}"`) }];
      return { proposed: `remove daily goal ${g.name}` };
    }
    const type = args.type === "numeric" ? "numeric" : "boolean";
    const def: CustomGoalDef = { id: crypto.randomUUID().slice(0, 8), name, type, ...(type === "numeric" ? { unit: str(args.unit), target: num(args.target) } : {}) };
    const clean = JSON.parse(JSON.stringify(def)) as CustomGoalDef;
    ctx.draft.actions = [...(ctx.draft.actions ?? []).filter((a) => a.type !== "profile_update"), { type: "profile_update", changes: { customGoals: [...defs, clean] }, label: ownLabel(ctx, `הוספת יעד יומי "${name}"`, `add daily goal "${name}"`) }];
    return { proposed: `add daily goal ${name}`, goal: clean };
  },
};

const setDailyGoal: Tool = {
  def: fn(
    "set_daily_goal",
    "Mark a custom daily goal done / set its numeric progress for a day (written immediately — it's the same as ticking the box in the app; tell the user it's done). goal = its name or id from manage_custom_goals.",
    { goal: { type: "string" }, date: DATE_PROP, done: { type: "boolean" }, value: { type: "number" }, note: { type: "string" } },
    ["goal"],
  ),
  async run(args, ctx) {
    const defs: CustomGoalDef[] = (ctx.state.profile?.customGoals ?? []) as CustomGoalDef[];
    const q = (str(args.goal) ?? "").toLowerCase();
    const g = defs.find((d) => d.id === args.goal) ?? defs.find((d) => d.name.toLowerCase() === q) ?? defs.find((d) => d.name.toLowerCase().includes(q));
    if (!g) return { error: "No such custom goal.", existing: defs.map((d) => d.name) };
    const date = asDate(args.date, ctx);
    const value = num(args.value);
    const done = typeof args.done === "boolean" ? args.done : g.type === "numeric" ? (value ?? 0) >= (g.target ?? 0) : true;
    const entry: DailyGoalEntry = { goalId: g.id, done, ...(value != null ? { value } : {}), ...(str(args.note) ? { note: str(args.note) } : {}) };
    if (ctx.dryRun) return { set: { goal: g.name, date, ...entry } };
    const ref = adminDb.collection("users").doc(ctx.uid).collection("dailyGoals").doc(date);
    const current = ((await ref.get()).data() as DailyGoals | undefined)?.entries ?? [];
    await ref.set({ date, entries: [...current.filter((e) => e.goalId !== g.id), entry] });
    return { set: { goal: g.name, date, done, value } };
  },
};

const getSettings: Tool = {
  def: fn("get_settings", "Everything the user can see in the app's Profile/settings: full profile (goals, stats, preferences), custom daily goals, built-in WhatsApp reminder settings, custom reminders. Use to answer 'what are my goals/settings/reminders'.", {}),
  async run(_args, ctx) {
    const snap = await adminDb.collection("whatsappReminders").doc(ctx.uid).get();
    const r = snap.data() as WhatsAppReminderSettings | undefined;
    const { email: _e, whatsappPhone: _p, ...profile } = (ctx.state.profile ?? {}) as Record<string, unknown>;
    return {
      profile,
      whatsapp_linked: !!ctx.state.profile?.whatsappPhone,
      builtin_reminders: r ? { breakfastCheckIn: r.breakfastCheckIn, middayCheckIn: r.middayCheckIn, eveningSummary: r.eveningSummary, morningRecap: r.morningRecap, weeklyWeighIn: r.weeklyWeighIn, customGoalsCheckIn: r.customGoalsCheckIn } : "not configured yet",
      custom_reminders: (r?.customReminders ?? []).map((c) => ({ id: c.id, intent: c.intent ?? c.text, time: c.time, recurrence: c.recurrence, weekday: c.weekday })),
      note: "For a full explanation of what each reminder sends, call manage_reminders with action=list.",
    };
  },
};

const BUILTIN = ["breakfastCheckIn", "middayCheckIn", "eveningSummary", "morningRecap", "weeklyWeighIn", "customGoalsCheckIn"];
const setBuiltinReminder: Tool = {
  def: fn(
    "set_builtin_reminder",
    "Turn one of the app's built-in WhatsApp check-ins on/off or change its time (written immediately, same as the toggles in Profile). breakfastCheckIn = nudge if no meal logged yet; middayCheckIn = nudge if calories are low so far (threshold_percent); eveningSummary = today's totals; morningRecap = yesterday's totals; weeklyWeighIn = Sunday weigh-in nudge; customGoalsCheckIn = unticked daily goals.",
    {
      type: { type: "string", enum: BUILTIN },
      enabled: { type: "boolean" },
      time: { type: "string", description: "HH:mm (Israel time)." },
      threshold_percent: { type: "number", description: "middayCheckIn only." },
    },
    ["type"],
  ),
  async run(args, ctx) {
    const type = BUILTIN.includes(String(args.type)) ? String(args.type) : null;
    if (!type) return { error: "unknown reminder type" };
    const time = str(args.time);
    if (time && !/^\d{2}:\d{2}$/.test(time)) return { error: "time must be HH:mm" };
    const ref = adminDb.collection("whatsappReminders").doc(ctx.uid);
    const existing = (await ref.get()).data() as Record<string, any> | undefined;
    if (!ctx.state.profile?.whatsappPhone) return { error: "No WhatsApp number is linked to this account." };
    const DEF: Record<string, { enabled: boolean; time: string }> = {
      breakfastCheckIn: { enabled: false, time: "10:00" }, middayCheckIn: { enabled: false, time: "14:00" }, eveningSummary: { enabled: false, time: "21:00" },
      morningRecap: { enabled: false, time: "08:00" }, weeklyWeighIn: { enabled: false, time: "09:00" }, customGoalsCheckIn: { enabled: false, time: "20:30" },
    };
    const cur = { ...DEF[type], ...(existing?.[type] ?? {}) } as Record<string, unknown>;
    const next = { ...cur, ...(typeof args.enabled === "boolean" ? { enabled: args.enabled } : {}), ...(time ? { time } : {}), ...(type === "middayCheckIn" && num(args.threshold_percent) != null ? { thresholdPercent: num(args.threshold_percent) } : {}) };
    if (type === "middayCheckIn" && next.thresholdPercent == null) next.thresholdPercent = 40;
    if (ctx.dryRun) return { set: { type, ...next } };
    await ref.set({ [type]: next, phone: ctx.state.profile.whatsappPhone, lang: ctx.state.profile.language ?? ctx.lang, lastSent: existing?.lastSent ?? {}, customReminders: existing?.customReminders ?? [], updatedAt: new Date().toISOString() }, { merge: true });
    return { set: { type, ...next } };
  },
};

export const TOOLS: Tool[] = [
  logFood,
  logWorkout,
  logSteps,
  logBodyMetrics,
  updateDraft,
  removeFromDraft,
  changeLoggedMeal,
  changeLoggedWorkout,
  deleteLoggedSteps,
  deleteLoggedBodyMetrics,
  updateProfile,
  manageCustomGoals,
  setDailyGoal,
  getSettings,
  setBuiltinReminder,
  findLogged,
  getHistory,
  lookupNutrition,
  searchWebTool,
  manageReminders,
  logWater,
  remember,
  forget,
  flagMistake,
];

export const TOOL_DEFS = TOOLS.map((t) => t.def);
export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.def.type === "function" ? t.def.function.name : "", t]));

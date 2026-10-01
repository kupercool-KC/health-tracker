/**
 * The agent's working memory for ONE turn: everything it needs to know about
 * "what exists right now" — what's already saved (with entry ids so it can
 * edit/delete the right one), what's waiting for confirmation (the draft),
 * the user's profile/goals, regular foods and long-term facts. Rebuilt from
 * Firestore on every message and handed to the model explicitly, so it never
 * has to guess saved-vs-proposed-vs-deleted from chat text (the root cause of
 * the repeated "bot lost track" failures of the old classifier pipeline).
 */
import "server-only";
import { FieldPath } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { getFrequentMealsForChat, type FrequentMealForChat } from "@/lib/nutrition/frequentMeals";
import { summarizeProfileForChat } from "@/lib/chat/chat";
import { readFacts, type AgentFact } from "./memory";
import type { ChatMessage, MealDay, PendingAction, UserProfile, Workout } from "@/lib/types";

export interface Draft {
  meal?: NonNullable<ChatMessage["pendingMeal"]>;
  mealAction?: NonNullable<ChatMessage["pendingMealAction"]>;
  workout?: NonNullable<ChatMessage["pendingWorkout"]>;
  steps?: NonNullable<ChatMessage["pendingSteps"]>;
  bodyMetrics?: NonNullable<ChatMessage["pendingBodyMetrics"]>;
  /** Edits/deletes of saved workouts/steps/weigh-ins and profile changes — see PendingAction. */
  actions?: PendingAction[];
}

export interface SavedMealEntry {
  id: string;
  name: string;
  calories: number;
  protein: number;
}

export interface AgentState {
  nowLocal: string;
  today: string;
  yesterday: string;
  weekday: string;
  meals: { date: string; entries: SavedMealEntry[]; totalCalories: number; totalProtein: number }[];
  workouts: { id: string; date: string; type: string; durationMin: number; distanceKm?: number; calories?: number }[];
  stepsToday?: number;
  calorieGoal?: number;
  proteinGoal?: number;
  profile: Partial<UserProfile> | undefined;
  profileSummary: string | null;
  userName?: string;
  facts: AgentFact[];
  frequentMeals: FrequentMealForChat[];
}

/** An open proposal this recent is still "live" for confirmation — matches the WhatsApp confirm lookback. */
export const OPEN_PROPOSAL_LOOKBACK = 8;

export function hasPending(m: ChatMessage): boolean {
  return !!(m.pendingMeal || m.pendingMealAction || m.pendingWorkout || m.pendingSteps || m.pendingBodyMetrics || m.pendingActions?.length);
}

export function draftFromMessage(m: ChatMessage): Draft {
  return {
    ...(m.pendingMeal ? { meal: structuredClone(m.pendingMeal) } : {}),
    ...(m.pendingMealAction ? { mealAction: structuredClone(m.pendingMealAction) } : {}),
    ...(m.pendingWorkout ? { workout: structuredClone(m.pendingWorkout) } : {}),
    ...(m.pendingSteps ? { steps: structuredClone(m.pendingSteps) } : {}),
    ...(m.pendingBodyMetrics ? { bodyMetrics: structuredClone(m.pendingBodyMetrics) } : {}),
    ...(m.pendingActions?.length ? { actions: structuredClone(m.pendingActions) } : {}),
  };
}

export function isDraftEmpty(d: Draft): boolean {
  return !(d.meal || d.mealAction || d.workout || d.steps || d.bodyMetrics || d.actions?.length);
}

/** Index of the most recent still-open proposal message within the lookback, or -1. */
export function findOpenProposalIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - OPEN_PROPOSAL_LOOKBACK); i--) {
    if (messages[i].role === "assistant" && hasPending(messages[i])) return i;
  }
  return -1;
}

function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const WEEKDAYS_HE = ["יום ראשון", "יום שני", "יום שלישי", "יום רביעי", "יום חמישי", "יום שישי", "שבת"];

export function localClock(nowIso: string): { hm: string } {
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(nowIso));
  return { hm };
}

export async function buildAgentState(uid: string, today: string, nowIso: string): Promise<AgentState> {
  const u = adminDb.collection("users").doc(uid);
  const since = addDays(today, -2);
  const [profileSnap, mealSnap, workoutSnap, stepsSnap, facts, frequentMeals] = await Promise.all([
    u.collection("meta").doc("profile").get(),
    u.collection("meals").where(FieldPath.documentId(), ">=", since).get(),
    u.collection("workouts").where("date", ">=", since).get(),
    u.collection("steps").doc(today).get(),
    readFacts(uid),
    getFrequentMealsForChat(uid),
  ]);
  const profile = profileSnap.data() as UserProfile | undefined;

  const meals = mealSnap.docs
    .map((d) => d.data() as MealDay)
    .filter((d) => d.date <= today)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((d) => ({
      date: d.date,
      entries: (d.entries ?? []).map((e) => ({ id: e.id, name: e.name, calories: Math.round(e.calories), protein: Math.round(e.protein * 10) / 10 })),
      totalCalories: Math.round(d.totals?.calories ?? 0),
      totalProtein: Math.round(d.totals?.protein ?? 0),
    }));

  const workouts = workoutSnap.docs
    .map((d) => d.data() as Workout)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((w) => ({
      id: w.id,
      date: w.date,
      type: w.type,
      durationMin: Math.round(w.duration / 60),
      ...(w.distance != null ? { distanceKm: Math.round(w.distance / 100) / 10 } : {}),
      ...(w.calories != null ? { calories: Math.round(w.calories) } : {}),
    }));

  const { hm } = localClock(nowIso);
  const weekday = WEEKDAYS_HE[new Date(`${today}T12:00:00Z`).getUTCDay()];
  return {
    nowLocal: `${today} ${hm}`,
    today,
    yesterday: addDays(today, -1),
    weekday,
    meals,
    workouts,
    stepsToday: (stepsSnap.data() as { steps?: number } | undefined)?.steps,
    calorieGoal: profile?.calorieGoal,
    proteinGoal: profile?.proteinGoal,
    profile,
    profileSummary: summarizeProfileForChat(profile),
    userName: profile?.name,
    facts,
    frequentMeals,
  };
}

export function renderState(state: AgentState, draft: Draft): string {
  const lines: string[] = [];
  lines.push(`NOW: ${state.nowLocal} (Israel time), ${state.weekday}. today=${state.today}, yesterday=${state.yesterday}.`);
  if (state.userName) lines.push(`User's name: ${state.userName}${state.profile?.gender ? ` (gender: ${state.profile.gender})` : ""}.`);
  if (state.profileSummary) lines.push(`Profile: ${state.profileSummary}.`);

  lines.push("\nALREADY SAVED (these exist in the user's log right now — never log them again):");
  if (state.meals.length === 0) lines.push("  (no meals in the last 3 days)");
  for (const day of state.meals) {
    lines.push(`  Meals ${day.date} — total ${day.totalCalories} kcal / ${day.totalProtein}g protein:`);
    for (const e of day.entries) lines.push(`    - [${e.id}] ${e.name}: ${e.calories} kcal, ${e.protein}g protein`);
  }
  for (const w of state.workouts) {
    lines.push(`  Workout ${w.date} [${w.id}]: ${w.type}, ${w.durationMin} min${w.distanceKm != null ? `, ${w.distanceKm} km` : ""}${w.calories != null ? `, ${w.calories} kcal` : ""}`);
  }
  if (state.stepsToday != null) lines.push(`  Steps today: ${state.stepsToday}`);

  lines.push("\nDRAFT (proposed, NOT saved yet — waiting for the user's confirmation):");
  const draftLines = renderDraft(draft);
  lines.push(draftLines.length ? draftLines.map((l) => `  ${l}`).join("\n") : "  (empty)");

  if (state.frequentMeals.length) {
    lines.push("\nUSER'S REGULAR FOODS (name — last logged values), most habitual first. When they say \"my usual X\" / a vague name that matches one, use these values via log_food (keep the stored name):");
    for (const m of state.frequentMeals) lines.push(`  - ${m.name} — ${m.calories} kcal, ${m.protein}g protein${m.grams != null ? `, ~${m.grams}g` : ""}`);
  }
  if (state.facts.length) {
    lines.push("\nLONG-TERM MEMORY (facts you saved about this user earlier):");
    for (const f of state.facts) lines.push(`  - [${f.id}] ${f.text}`);
  }
  return lines.join("\n");
}

export function renderDraft(draft: Draft): string[] {
  const out: string[] = [];
  if (draft.meal) {
    out.push(`Meal proposal for ${draft.meal.date ?? "today"}:`);
    draft.meal.items.forEach((it, i) => out.push(`  #${i}: ${it.description} — ${Math.round(it.calories)} kcal, ${Math.round(it.protein * 10) / 10}g protein`));
  }
  if (draft.workout) {
    const w = draft.workout;
    out.push(`Workout proposal for ${w.date}: ${w.type}, ${Math.round(w.durationSec / 60)} min${w.distanceMeters != null ? `, ${(w.distanceMeters / 1000).toFixed(1)} km` : ""}${w.calories != null ? `, ${Math.round(w.calories)} kcal` : ""}`);
  }
  if (draft.steps) out.push(`Steps proposal for ${draft.steps.date}: ${draft.steps.steps}`);
  if (draft.bodyMetrics) out.push(`Body-metrics proposal for ${draft.bodyMetrics.date}: ${JSON.stringify(draft.bodyMetrics)}`);
  for (const a of draft.actions ?? []) out.push(`Proposed action: ${a.label}`);
  if (draft.mealAction) {
    const a = draft.mealAction;
    out.push(`Proposed ${a.action} of saved meal "${a.entryName}" (${a.date})${a.changes ? ` with changes ${JSON.stringify(a.changes)}` : ""}`);
  }
  return out;
}

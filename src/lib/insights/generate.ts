/**
 * Insight generation (server): detectors → ranker → phrasing → users/{uid}/insights/{id}.
 * Max one daily insight per user per day; the weekly review is a separate "weekly" insight (Sunday).
 * Guardrails: no medical advice, neutral wording, numbers only from the evidence, calorie floor in the detector.
 */
import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { getOpenAIClient } from "@/lib/openai/client";
import { israelDateKey } from "@/lib/metrics/compute";
import { detect, goalWeight, type Candidate } from "./detectors";
import type { DailyStats, Insight, InsightText, InsightType, MetricsCurrent, UserProfile } from "@/lib/types";

const DAY_MS = 86_400_000;
const THRESHOLD = 0.35;
const NOVELTY_DAYS = 7;

const TITLES: Record<InsightType, { he: string; en: string }> = {
  proteinLow: { he: "חלבון", en: "Protein" },
  restDayProtein: { he: "חלבון בימי מנוחה", en: "Rest-day protein" },
  weekendGap: { he: "סוף שבוע", en: "Weekends" },
  plateau: { he: "המשקל עומד במקום", en: "Weight plateau" },
  sodiumHigh: { he: "נתרן", en: "Sodium" },
  fiberLow: { he: "סיבים", en: "Fiber" },
  trainingDrop: { he: "אימונים", en: "Training" },
  sleepIntake: { he: "שינה ואכילה", en: "Sleep and eating" },
  streak: { he: "כל הכבוד", en: "Nice streak" },
  aheadOfPlan: { he: "לפני התוכנית", en: "Ahead of plan" },
  recalibrate: { he: "עדכון יעד קלוריות", en: "Calorie goal check" },
  waterLow: { he: "שתייה", en: "Water" },
  weeklyReview: { he: "סיכום שבועי", en: "Weekly review" },
};

const ACTION_LABEL = {
  askLily: { he: "תעזרי לי", en: "Ask Lily" },
  accept: { he: "עדכון היעד", en: "Update my goal" },
  keep: { he: "להשאיר", en: "Keep it" },
};

export async function loadStats(uid: string, days = 35): Promise<DailyStats[]> {
  const from = israelDateKey(new Date(Date.now() - (days - 1) * DAY_MS));
  const snap = await adminDb.collection("users").doc(uid).collection("dailyStats").where("date", ">=", from).get();
  return snap.docs.map((d) => d.data() as DailyStats).sort((a, b) => a.date.localeCompare(b.date));
}

/** Short, neutral phrasing of one candidate. Falls back to a plain sentence if the model fails. */
async function phrase(c: Candidate, lang: "he" | "en", profile: UserProfile): Promise<string> {
  const fallback = lang === "he" ? "יש לי מחשבה קטנה על השבוע שלך. רוצה לשמוע?" : "I noticed something small about your week. Want to hear it?";
  try {
    const completion = await getOpenAIClient().chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            `You write one short, warm, non-judgmental coaching note for a nutrition app, in ${lang === "he" ? "Hebrew (use feminine-neutral, address the user directly; avoid gendered verbs when possible)" : "English"}. ` +
            "Exactly two sentences: (1) what the data shows, using ONLY the numbers in EVIDENCE, (2) why it matters for THEIR goal (or, for a positive insight, a short genuine encouragement). " +
            "Never use words like bad, failed, cheat, guilty; no medical advice or diagnosis; no calorie targets below safe levels; do not invent numbers; no emoji; do not mention the action button. " +
            'Respond ONLY as JSON {"body": string}.',
        },
        { role: "user", content: JSON.stringify({ type: c.type, evidence: c.evidence, goals: profile.goals ?? [], calorieGoal: profile.calorieGoal, proteinGoal: profile.proteinGoal }) },
      ],
    });
    const body = (JSON.parse(completion.choices[0]?.message?.content ?? "{}") as { body?: string }).body?.trim();
    return body && body.length < 400 ? body : fallback;
  } catch {
    return fallback;
  }
}

export async function generateDailyInsight(uid: string, metrics: MetricsCurrent, profile: UserProfile): Promise<Insight | null> {
  const lang: "he" | "en" = profile.language === "en" ? "en" : "he";
  const today = metrics.today;
  const col = adminDb.collection("users").doc(uid).collection("insights");

  const recent = (await col.where("date", ">=", israelDateKey(new Date(Date.now() - 30 * DAY_MS))).get()).docs.map((d) => d.data() as Insight);
  if (recent.some((i) => i.kind === "daily" && i.date === today)) return null; // already have today's

  const stats = await loadStats(uid);
  if (stats.length < 7) return null;
  const candidates = detect({ stats, metrics, profile });

  const scored = candidates
    .map((c) => {
      const seenRecently = recent.some((i) => i.type === c.type && i.date >= israelDateKey(new Date(Date.now() - NOVELTY_DAYS * DAY_MS)));
      // Recalibrate is offered at most every 4 weeks.
      const recentlyRecal = c.type === "recalibrate" && recent.some((i) => i.type === "recalibrate" && i.date >= israelDateKey(new Date(Date.now() - 28 * DAY_MS)));
      const dismissed = recent.filter((i) => i.type === c.type && i.status === "dismissed").length;
      const novelty = seenRecently || recentlyRecal ? 0 : 1 / (1 + dismissed);
      return { c, score: c.effect * goalWeight(c.type, profile.goals) * novelty };
    })
    .filter((x) => x.score >= THRESHOLD)
    .sort((a, b) => b.score - a.score);
  const top = scored[0]?.c;
  if (!top) return null;

  const [bodyHe, bodyEn] = await Promise.all([phrase(top, "he", profile), phrase(top, "en", profile)]);
  const body = lang === "he" ? bodyHe : bodyEn;
  const id = `${today}-${top.type}`;
  const text = (l: "he" | "en", b: string): InsightText => ({
    title: TITLES[top.type][l],
    body: b,
    ...(top.action?.kind === "askLily" ? { actionLabel: ACTION_LABEL.askLily[l], prompt: l === "he" ? top.action.promptHe : top.action.promptEn } : {}),
    ...(top.action?.kind === "applyCalorieGoal" ? { actionLabel: ACTION_LABEL.accept[l], keepLabel: ACTION_LABEL.keep[l] } : {}),
  });
  const action: Insight["action"] =
    top.action?.kind === "askLily"
      ? { kind: "askLily", label: ACTION_LABEL.askLily[lang], prompt: lang === "he" ? top.action.promptHe : top.action.promptEn }
      : top.action?.kind === "applyCalorieGoal"
        ? { kind: "applyCalorieGoal", label: ACTION_LABEL.accept[lang], value: top.action.value, keepLabel: ACTION_LABEL.keep[lang] }
        : undefined;
  const insight: Insight = {
    id,
    type: top.type,
    kind: "daily",
    title: TITLES[top.type][lang],
    body,
    i18n: { he: text("he", bodyHe), en: text("en", bodyEn) },
    ...(action ? { action } : {}),
    evidence: top.evidence,
    status: "new",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 2 * DAY_MS).toISOString(),
    date: today,
  };
  await col.doc(id).set(insight);
  return insight;
}

/** Deterministic weekly review text (no LLM numbers). Used both in the app card and on WhatsApp; never mentions the extra nutrients. */
export function weeklyReviewText(metrics: MetricsCurrent, lang: "he" | "en", topInsightBody?: string): string {
  const a = metrics.adherence;
  const w = metrics.weight;
  const rate = w?.weeklyRateKg;
  if (lang === "he") {
    return [
      "סיכום שבועי 📋",
      `קלוריות: עמדת ביעד ב־${a.calorieDays7} מתוך ${a.loggedDays7} ימים. חלבון: ${a.proteinDays7} מתוך ${a.loggedDays7}.`,
      `אימונים: ${metrics.workouts7.count} (${metrics.workouts7.minutes} דקות).`,
      rate != null ? `משקל: מגמה של ${rate > 0 ? "+" : ""}${rate} ק״ג בשבוע (כרגע ${w!.trendKg} ק״ג).` : null,
      topInsightBody ? `\n${topInsightBody}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    "Weekly review 📋",
    `Calories: on target ${a.calorieDays7} of ${a.loggedDays7} days. Protein: ${a.proteinDays7} of ${a.loggedDays7}.`,
    `Workouts: ${metrics.workouts7.count} (${metrics.workouts7.minutes} min).`,
    rate != null ? `Weight: trend ${rate > 0 ? "+" : ""}${rate} kg a week (now ${w!.trendKg} kg).` : null,
    topInsightBody ? `\n${topInsightBody}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function createWeeklyReview(uid: string, metrics: MetricsCurrent, profile: UserProfile): Promise<Insight | null> {
  if (metrics.adherence.loggedDays7 < 3) return null;
  const lang: "he" | "en" = profile.language === "en" ? "en" : "he";
  const today = metrics.today;
  const col = adminDb.collection("users").doc(uid).collection("insights");
  const id = `${today}-weekly`;
  if ((await col.doc(id).get()).exists) return null;
  const latestDaily = (await col.where("date", ">=", israelDateKey(new Date(Date.now() - 6 * DAY_MS))).get()).docs.map((d) => d.data() as Insight).filter((i) => i.kind === "daily" && i.status !== "dismissed" && !i.action?.hasOwnProperty("value")).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const insight: Insight = {
    id,
    type: "weeklyReview",
    kind: "weekly",
    title: TITLES.weeklyReview[lang],
    body: weeklyReviewText(metrics, lang, latestDaily?.i18n?.[lang]?.body ?? latestDaily?.body),
    i18n: {
      he: { title: TITLES.weeklyReview.he, body: weeklyReviewText(metrics, "he", latestDaily?.i18n?.he.body ?? (lang === "he" ? latestDaily?.body : undefined)) },
      en: { title: TITLES.weeklyReview.en, body: weeklyReviewText(metrics, "en", latestDaily?.i18n?.en.body ?? (lang === "en" ? latestDaily?.body : undefined)) },
    },
    evidence: { loggedDays7: metrics.adherence.loggedDays7 },
    status: "new",
    createdAt: new Date().toISOString(),
    // Shown until Monday night (Israel).
    expiresAt: new Date(Date.now() + 28 * 3600 * 1000).toISOString(),
    date: today,
  };
  await col.doc(id).set(insight);
  return insight;
}

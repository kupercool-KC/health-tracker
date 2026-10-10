/**
 * GET /api/cron/whatsapp-reminders
 * Auth: `Authorization: Bearer ${CRON_SECRET}`.
 *
 * Triggered every 15 minutes by a GitHub Actions scheduled workflow (see
 * .github/workflows/whatsapp-reminders.yml) rather than Vercel's own Cron —
 * Vercel's Hobby plan only allows once-daily cron jobs, which can't cover
 * several different times of day. For every user with a
 * whatsappReminders/{uid} doc (written by /api/whatsapp/reminders, one per
 * linked WhatsApp user), checks each of their six built-in reminder types —
 * if it's enabled, its configured time (Israel local, HH:mm) falls in the
 * current 15-minute bucket, it hasn't already fired today (lastSent[type]),
 * and its own data condition holds (e.g. no meals logged yet) — sends the
 * WhatsApp message and records lastSent[type] = today. Also checks their
 * user-defined customReminders the same way (see src/lib/reminders/manage.ts).
 */
import { NextResponse, after } from "next/server";
import { runInsightDeliveries, runNightlyIfDue } from "@/lib/insights/scheduler";
import { adminDb } from "@/lib/firebase/admin";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
import { getOpenAIClient } from "@/lib/openai/client";
import type { CustomGoalDef, DailyGoalEntry, DailyGoals, MealDay, UserProfile, WhatsAppReminderSettings } from "@/lib/types";

type ReminderType = keyof WhatsAppReminderSettings["lastSent"];

function israelNow(): { date: string; hm: string; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const hm = `${get("hour")}:${get("minute")}`;
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekday = weekdayNames.indexOf(get("weekday"));
  return { date, hm, weekday };
}

const toMinutes = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
};

/**
 * A reminder is due from its configured time until DUE_WINDOW_MIN later, once
 * per day. The old "same 15-minute bucket" test silently skipped a reminder
 * whenever it was created inside the bucket the cron had already passed
 * (e.g. created 20:37 for 20:38 — the 20:30 run was too early, the 20:45 run
 * a different bucket → never fired) and fired up to 14 minutes EARLY.
 * `createdAt` guards the other direction: a reminder created after today's
 * time has passed means "from tomorrow", not "right now".
 */
const DUE_WINDOW_MIN = 120;
function isDue(now: { date: string; hm: string }, configuredTime: string, createdAt?: string): boolean {
  const nowMin = toMinutes(now.hm);
  const target = toMinutes(configuredTime);
  if (nowMin < target || nowMin - target > DUE_WINDOW_MIN) return false;
  if (createdAt) {
    const created = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(createdAt));
    const g = (t: string) => created.find((p) => p.type === t)?.value ?? "";
    if (`${g("year")}-${g("month")}-${g("day")}` === now.date && toMinutes(`${g("hour")}:${g("minute")}`) > target) return false;
  }
  return true;
}

/** Today's balance the way the app's net-calorie view computes it: workout burn counts at netCalorieBurnFactor% (default 50), so "remaining" is goal − (eaten − credited burn). */
function dayBalance(mealDay: MealDay | undefined, workouts: { calories?: number }[], profile: UserProfile | undefined) {
  const eaten = Math.round(mealDay?.totals.calories ?? 0);
  const protein = Math.round(mealDay?.totals.protein ?? 0);
  const factor = (profile?.netCalorieBurnFactor ?? 50) / 100;
  const burned = Math.round(workouts.reduce((sum, w) => sum + (w.calories ?? 0), 0) * factor);
  const net = eaten - burned;
  return {
    eaten,
    burned,
    net,
    caloriesRemaining: profile?.calorieGoal != null ? Math.round(profile.calorieGoal - net) : undefined,
    protein,
    proteinRemaining: profile?.proteinGoal != null ? Math.round(profile.proteinGoal - protein) : undefined,
  };
}

/** The chat can be in Hebrew while the stored reminder language (copied from the web app's toggle) says "en" — the language the user actually writes in wins. */
async function resolveLang(uid: string, stored: "en" | "he"): Promise<"en" | "he"> {
  try {
    const sessionId = ((await adminDb.collection("users").doc(uid).collection("meta").doc("whatsapp").get()).data() as { sessionId?: string } | undefined)?.sessionId;
    if (!sessionId) return stored;
    const session = (await adminDb.collection("users").doc(uid).collection("chatSessions").doc(sessionId).get()).data() as { messages?: { role: string; content: string }[] } | undefined;
    const lastText = [...(session?.messages ?? [])].reverse().find((m) => m.role === "user" && /[A-Za-z\u0590-\u05FF]{3}/.test(m.content));
    return lastText ? (/[\u0590-\u05FF]/.test(lastText.content) ? "he" : "en") : stored;
  } catch {
    return stored;
  }
}

/** Writes the reminder the way a friend would, using today's real numbers — not the user's request copied back verbatim. Falls back to the stored text on any failure. */
async function composeReminderText(uid: string, reminder: { intent?: string; text: string }, lang: "en" | "he", today: string): Promise<string> {
  try {
    const usersCol = adminDb.collection("users").doc(uid);
    const [mealsSnap, profileSnap, workoutsSnap] = await Promise.all([
      usersCol.collection("meals").doc(today).get(),
      usersCol.collection("meta").doc("profile").get(),
      usersCol.collection("workouts").where("date", "==", today).get(),
    ]);
    const meals = mealsSnap.data() as MealDay | undefined;
    const profile = profileSnap.data() as UserProfile | undefined;
    const balance = dayBalance(meals, workoutsSnap.docs.map((d) => d.data() as { calories?: number }), profile);
    const context = {
      userName: profile?.name,
      userGender: profile?.gender,
      mealsLoggedToday: meals?.entries.length ?? 0,
      caloriesSoFar: Math.round(meals?.totals.calories ?? 0),
      calorieGoal: profile?.calorieGoal,
      proteinSoFar: Math.round(meals?.totals.protein ?? 0),
      proteinGoal: profile?.proteinGoal,
      workoutsToday: workoutsSnap.size,
      caloriesBurnedCreditedFromWorkouts: balance.burned,
      netCaloriesSoFar: balance.net,
      netCaloriesRemainingToGoal: balance.caloriesRemaining,
      proteinRemainingToGoal: balance.proteinRemaining, // negative = already above the goal
    };
    const completion = await getOpenAIClient().chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      max_tokens: 160,
      messages: [
        {
          role: "system",
          content: `You are Lilly, the user's warm nutrition-and-fitness companion, sending a scheduled WhatsApp reminder. Write ONE short, friendly, personal message (1–3 short sentences, plain text, at most one emoji) in ${lang === "he" ? "natural colloquial Hebrew" : "English"} that gently nudges the user to do what they asked to be reminded of. Use the day's real numbers when they make the nudge more useful (e.g. few/no meals logged yet). If the reminder is about logging intake / the daily summary / what's left, ALWAYS state how many calories (net, netCaloriesRemainingToGoal) and how much protein (proteinRemainingToGoal) are left — or by how much they're over. Never invent data. Don't copy the request word-for-word; don't be pushy or robotic. Address the user in the grammatical gender matching userGender (male → masculine Hebrew forms, female → feminine; unknown → phrase neutrally). Output only the message.`,
        },
        { role: "user", content: JSON.stringify({ whatTheyAskedToBeRemindedOf: reminder.intent ?? reminder.text, today: context }) },
      ],
    });
    const text = completion.choices[0]?.message?.content?.trim();
    return text || reminder.text;
  } catch (err) {
    console.error("[cron/whatsapp-reminders] compose failed, using stored text:", err);
    return reminder.text;
  }
}

function yesterday(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const texts = {
  breakfastCheckIn: {
    he: "🍳 עדיין לא נרשמה אף ארוחה היום. אל תשכח לתעד!",
    en: "🍳 No meals logged yet today. Don't forget to log them!",
  },
  weeklyWeighIn: {
    he: "⚖️ תזכורת שבועית — אל תשכח לשקול את עצמך ולשלוח לי צילום מסך מהמשקל.",
    en: "⚖️ Weekly reminder — don't forget to weigh in and send me a screenshot from your scale.",
  },
} as const;

async function evaluateAndSend(
  uid: string,
  type: ReminderType,
  settings: WhatsAppReminderSettings,
  now: { date: string; hm: string; weekday: number },
): Promise<boolean> {
  const config = settings[type as keyof Omit<WhatsAppReminderSettings, "phone" | "lang" | "lastSent" | "updatedAt">] as
    | { enabled: boolean; time: string; thresholdPercent?: number }
    | undefined;
  if (!config?.enabled) return false;
  if (settings.lastSent[type] === now.date) return false;
  if (!isDue(now, config.time)) return false;
  if (type === "weeklyWeighIn" && now.weekday !== 0) return false;

  const lang = await resolveLang(uid, settings.lang);
  const usersCol = adminDb.collection("users").doc(uid);

  if (type === "breakfastCheckIn") {
    const meals = (await usersCol.collection("meals").doc(now.date).get()).data() as MealDay | undefined;
    if ((meals?.entries.length ?? 0) > 0) return false;
    await sendWhatsAppText(settings.phone, texts.breakfastCheckIn[lang]);
    return true;
  }

  if (type === "weeklyWeighIn") {
    const weighIn = await usersCol.collection("bodyMetrics").doc(now.date).get();
    if (weighIn.exists) return false;
    await sendWhatsAppText(settings.phone, texts.weeklyWeighIn[lang]);
    return true;
  }

  if (type === "middayCheckIn") {
    const [meals, profileSnap] = await Promise.all([
      usersCol.collection("meals").doc(now.date).get(),
      usersCol.collection("meta").doc("profile").get(),
    ]);
    const mealDay = meals.data() as MealDay | undefined;
    const profile = profileSnap.data() as UserProfile | undefined;
    const goal = profile?.calorieGoal ?? 0;
    const soFar = mealDay?.totals.calories ?? 0;
    const threshold = config.thresholdPercent ?? 40;
    if (goal === 0 || (soFar / goal) * 100 >= threshold) return false;
    const percent = Math.round((soFar / goal) * 100);
    const msg =
      lang === "he"
        ? `📊 עד עכשיו נרשמו ${Math.round(soFar)} קלוריות (${percent}% מהיעד). אל תשכח לתעד את הארוחות שלך היום.`
        : `📊 Only ${Math.round(soFar)} calories logged so far (${percent}% of goal). Don't forget to log today's meals.`;
    await sendWhatsAppText(settings.phone, msg);
    return true;
  }

  if (type === "eveningSummary") {
    const [meals, workoutsSnap, steps, profileSnap] = await Promise.all([
      usersCol.collection("meals").doc(now.date).get(),
      usersCol.collection("workouts").where("date", "==", now.date).get(),
      usersCol.collection("steps").doc(now.date).get(),
      usersCol.collection("meta").doc("profile").get(),
    ]);
    const mealDay = meals.data() as MealDay | undefined;
    const profile = profileSnap.data() as UserProfile | undefined;
    const stepsCount = (steps.data() as { steps?: number } | undefined)?.steps ?? 0;
    const workoutCount = workoutsSnap.size;
    const b = dayBalance(mealDay, workoutsSnap.docs.map((d) => d.data() as { calories?: number }), profile);
    const calories = b.eaten;
    const protein = b.protein;
    const calLeft = b.caloriesRemaining;
    const proLeft = b.proteinRemaining;
    const balanceHe = [
      calLeft != null ? (calLeft >= 0 ? `נשארו ${calLeft} קלוריות נטו` : `חרגת ב-${-calLeft} קלוריות נטו`) : null,
      proLeft != null ? (proLeft > 0 ? `חסרים ${proLeft}ג חלבון` : "יעד החלבון הושג") : null,
    ].filter(Boolean).join(" · ");
    const balanceEn = [
      calLeft != null ? (calLeft >= 0 ? `${calLeft} net kcal left` : `${-calLeft} net kcal over`) : null,
      proLeft != null ? (proLeft > 0 ? `${proLeft}g protein to go` : "protein goal reached") : null,
    ].filter(Boolean).join(" · ");
    const msg =
      lang === "he"
        ? `📅 סיכום היום:\n${calories}/${profile?.calorieGoal ?? "?"} קלוריות\n${protein}/${profile?.proteinGoal ?? "?"}ג חלבון\n${stepsCount}/${profile?.stepGoal ?? "?"} צעדים\n${workoutCount} אימונים${balanceHe ? `\n⚖️ מאזן: ${balanceHe}` : ""}`
        : `📅 Today's summary:\n${calories}/${profile?.calorieGoal ?? "?"} kcal\n${protein}/${profile?.proteinGoal ?? "?"}g protein\n${stepsCount}/${profile?.stepGoal ?? "?"} steps\n${workoutCount} workouts${balanceEn ? `\n⚖️ Balance: ${balanceEn}` : ""}`;
    await sendWhatsAppText(settings.phone, msg);
    return true;
  }

  if (type === "morningRecap") {
    const yDate = yesterday(now.date);
    const [meals, workoutsSnap, steps, profileSnap] = await Promise.all([
      usersCol.collection("meals").doc(yDate).get(),
      usersCol.collection("workouts").where("date", "==", yDate).get(),
      usersCol.collection("steps").doc(yDate).get(),
      usersCol.collection("meta").doc("profile").get(),
    ]);
    const mealDay = meals.data() as MealDay | undefined;
    const profile = profileSnap.data() as UserProfile | undefined;
    const stepsCount = (steps.data() as { steps?: number } | undefined)?.steps ?? 0;
    const workoutCount = workoutsSnap.size;
    const calories = Math.round(mealDay?.totals.calories ?? 0);
    const protein = Math.round(mealDay?.totals.protein ?? 0);
    const msg =
      lang === "he"
        ? `☀️ בוקר טוב! אתמול:\n${calories}/${profile?.calorieGoal ?? "?"} קלוריות\n${protein}/${profile?.proteinGoal ?? "?"}ג חלבון\n${stepsCount} צעדים\n${workoutCount} אימונים`
        : `☀️ Good morning! Yesterday:\n${calories}/${profile?.calorieGoal ?? "?"} kcal\n${protein}/${profile?.proteinGoal ?? "?"}g protein\n${stepsCount} steps\n${workoutCount} workouts`;
    await sendWhatsAppText(settings.phone, msg);
    return true;
  }

  if (type === "customGoalsCheckIn") {
    const profileSnap = await usersCol.collection("meta").doc("profile").get();
    const profile = profileSnap.data() as UserProfile | undefined;
    const goalDefs = profile?.customGoals ?? [];
    if (goalDefs.length === 0) return false;
    const dailyGoalsSnap = await usersCol.collection("dailyGoals").doc(now.date).get();
    const entries = (dailyGoalsSnap.data() as DailyGoals | undefined)?.entries ?? [];
    const entryById = new Map(entries.map((e: DailyGoalEntry) => [e.goalId, e]));
    const notDone = goalDefs.filter((g: CustomGoalDef) => {
      const entry = entryById.get(g.id);
      if (g.type === "boolean") return !entry?.done;
      return (entry?.value ?? 0) < (g.target ?? 0);
    });
    if (notDone.length === 0) return false;
    const names = notDone.map((g: CustomGoalDef) => g.name).join(", ");
    const msg =
      lang === "he" ? `✅ עדיין לא סימנת היום: ${names}` : `✅ Not marked done yet today: ${names}`;
    await sendWhatsAppText(settings.phone, msg);
    return true;
  }

  return false;
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = israelNow();
  const snap = await adminDb.collection("whatsappReminders").get();
  const types: ReminderType[] = [
    "breakfastCheckIn",
    "middayCheckIn",
    "eveningSummary",
    "morningRecap",
    "weeklyWeighIn",
    "customGoalsCheckIn",
  ];

  let sent = 0;
  for (const doc of snap.docs) {
    const settings = doc.data() as WhatsAppReminderSettings;
    if (!settings.phone) continue;
    for (const type of types) {
      try {
        const didSend = await evaluateAndSend(doc.id, type, settings, now);
        if (didSend) {
          sent++;
          await doc.ref.set({ lastSent: { ...settings.lastSent, [type]: now.date } }, { merge: true });
        }
      } catch (err) {
        console.error(`[cron/whatsapp-reminders] ${type} failed for ${doc.id}:`, err);
      }
    }

    for (const reminder of settings.customReminders ?? []) {
      try {
        if (reminder.lastSent === now.date) continue;
        if (!isDue(now, reminder.time, reminder.createdAt)) continue;
        if (reminder.recurrence === "weekly" && reminder.weekday !== now.weekday) continue;
        await sendWhatsAppText(settings.phone, await composeReminderText(doc.id, reminder, await resolveLang(doc.id, settings.lang), now.date));
        sent++;
        const updated = (settings.customReminders ?? []).map((r) =>
          r.id === reminder.id ? { ...r, lastSent: now.date } : r,
        );
        await doc.ref.set({ customReminders: updated }, { merge: true });
      } catch (err) {
        console.error(`[cron/whatsapp-reminders] custom reminder ${reminder.id} failed for ${doc.id}:`, err);
      }
    }
  }

  // Metrics + insights automation rides on this same ping (no extra cron job). Runs after the response so a slow night never delays reminders.
  after(async () => {
    try {
      await runNightlyIfDue(now);
      await runInsightDeliveries(now);
    } catch (err) {
      console.error("[cron/whatsapp-reminders] insights scheduler failed:", err);
    }
  });

  return NextResponse.json({ ok: true, checked: snap.size, sent });
}

export const maxDuration = 300;

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
import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
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

/** True if `configuredTime` (HH:mm) falls in the same 15-minute bucket as `nowHm` (HH:mm) — the cron only runs every 15 min, so an exact-minute match would silently never fire. */
function inCurrentBucket(nowHm: string, configuredTime: string): boolean {
  const toMinutes = (hm: string) => {
    const [h, m] = hm.split(":").map(Number);
    return h * 60 + m;
  };
  const now = toMinutes(nowHm);
  const target = toMinutes(configuredTime);
  return Math.floor(now / 15) === Math.floor(target / 15);
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
  if (!inCurrentBucket(now.hm, config.time)) return false;
  if (type === "weeklyWeighIn" && now.weekday !== 0) return false;

  const lang = settings.lang;
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
    const calories = Math.round(mealDay?.totals.calories ?? 0);
    const protein = Math.round(mealDay?.totals.protein ?? 0);
    const msg =
      lang === "he"
        ? `📅 סיכום היום:\n${calories}/${profile?.calorieGoal ?? "?"} קלוריות\n${protein}/${profile?.proteinGoal ?? "?"}ג חלבון\n${stepsCount}/${profile?.stepGoal ?? "?"} צעדים\n${workoutCount} אימונים`
        : `📅 Today's summary:\n${calories}/${profile?.calorieGoal ?? "?"} kcal\n${protein}/${profile?.proteinGoal ?? "?"}g protein\n${stepsCount}/${profile?.stepGoal ?? "?"} steps\n${workoutCount} workouts`;
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
        if (!inCurrentBucket(now.hm, reminder.time)) continue;
        if (reminder.recurrence === "weekly" && reminder.weekday !== now.weekday) continue;
        await sendWhatsAppText(settings.phone, reminder.text);
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

  return NextResponse.json({ ok: true, checked: snap.size, sent });
}

/**
 * Weekly deterministic "patterns" summary written to users/{uid}/meta/patterns and shown to Lily in every
 * conversation (app and WhatsApp): how this person trains and eats, from the last 28 days.
 */
import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { categoryOfName } from "@/lib/health/workoutMap";
import { israelDateKey } from "@/lib/metrics/compute";
import { loadStats } from "./generate";
import type { Workout } from "@/lib/types";

const DAY_MS = 86_400_000;
const WEEKDAYS_HE = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "שבת"];
const CATEGORY_HE: Record<string, string> = { running: "ריצה", walking: "הליכה", cycling: "אופניים", swimming: "שחייה", strength: "כוח", yoga: "יוגה", hiit: "HIIT", padel: "פאדל", other: "אחר" };

export async function writePatterns(uid: string): Promise<void> {
  const user = adminDb.collection("users").doc(uid);
  const from = israelDateKey(new Date(Date.now() - 27 * DAY_MS));
  const [workoutSnap, stats] = await Promise.all([user.collection("workouts").where("date", ">=", from).get(), loadStats(uid, 28)]);
  const workouts = workoutSnap.docs.map((d) => d.data() as Workout);

  // Workouts: sessions per week and usual weekdays per category.
  const byCat = new Map<string, { n: number; days: number[] }>();
  for (const w of workouts) {
    const cat = w.category ?? categoryOfName(w.type);
    const dow = new Date(`${w.date}T12:00:00Z`).getUTCDay();
    const cur = byCat.get(cat) ?? { n: 0, days: [0, 0, 0, 0, 0, 0, 0] };
    cur.n++;
    cur.days[dow]++;
    byCat.set(cat, cur);
  }
  const workoutPatterns = [...byCat.entries()]
    .filter(([, v]) => v.n >= 2)
    .sort((a, b) => b[1].n - a[1].n)
    .map(([cat, v]) => {
      const usual = v.days.map((n, i) => ({ n, i })).filter((x) => x.n >= 2).sort((a, b) => b.n - a.n).slice(0, 2).map((x) => WEEKDAYS_HE[x.i]);
      return `${CATEGORY_HE[cat] ?? cat} ~${Math.round((v.n / 4) * 10) / 10} בשבוע${usual.length ? ` (בעיקר ${usual.join(", ")})` : ""}`;
    })
    .join("; ");

  // Eating: weekday vs weekend, protein, consistency.
  const logged = stats.filter((d) => d.mealsLogged >= 2);
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  const isWe = (date: string) => [5, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
  const wd = logged.filter((d) => !isWe(d.date)), we = logged.filter((d) => isWe(d.date));
  const eatingPatterns =
    logged.length >= 7
      ? `ממוצע ${avg(logged.map((d) => d.calories))} קל׳ ו־${avg(logged.map((d) => d.protein))} ג׳ חלבון ביום; ` +
        (we.length >= 2 && wd.length >= 4 ? `סופ״ש ${avg(we.map((d) => d.calories))} קל׳ מול ${avg(wd.map((d) => d.calories))} באמצע השבוע; ` : "") +
        `תיעוד ב־${logged.length} מתוך 28 ימים`
      : "";

  await user.collection("meta").doc("patterns").set({ workoutPatterns, eatingPatterns, updatedAt: new Date().toISOString() });
}

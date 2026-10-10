/**
 * Automation for metrics + insights, driven by the existing 15-minute ping of /api/cron/whatsapp-reminders
 * (no extra cron job to set up):
 *  - runNightlyIfDue: once a day after 03:00 Israel — recompute metrics for every user, create the daily insight
 *    (and the weekly review on Sundays).
 *  - runInsightDeliveries: WhatsApp — the daily insight at 12:30 and the weekly review on Sunday 20:00, ON by default,
 *    per user opt-out via profile.insightPrefs. Only extra-nutrient-free text is sent.
 * Both are idempotent (date markers), so repeated or overlapping pings never double-send.
 */
import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
import { computeMetrics } from "@/lib/metrics/compute";
import { createWeeklyReview, generateDailyInsight } from "./generate";
import { writePatterns } from "./patterns";
import type { Insight, UserProfile } from "@/lib/types";

export interface IsraelNow {
  date: string;
  hm: string;
  weekday: number;
}

const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const inBucket = (hm: string, target: string) => minutes(hm) >= minutes(target) && minutes(hm) < minutes(target) + 15;

export async function runNightlyIfDue(now: IsraelNow): Promise<void> {
  if (minutes(now.hm) < minutes("03:00")) return;
  const flag = adminDb.collection("appConfig").doc("nightly");
  const claimed = await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(flag);
    if ((snap.data() as { date?: string } | undefined)?.date === now.date) return false;
    tx.set(flag, { date: now.date, startedAt: new Date().toISOString() });
    return true;
  });
  if (!claimed) return;
  const refs = await adminDb.collection("users").listDocuments();
  let metricsDone = 0;
  let insights = 0;
  for (const ref of refs) {
    try {
      const metrics = await computeMetrics(ref.id);
      if (!metrics) continue;
      metricsDone++;
      const profile = (await ref.collection("meta").doc("profile").get()).data() as UserProfile;
      if (await generateDailyInsight(ref.id, metrics, profile)) insights++;
      if (now.weekday === 0) {
        await createWeeklyReview(ref.id, metrics, profile);
        await writePatterns(ref.id);
      }
    } catch (err) {
      console.error("[nightly] failed for", ref.id, err);
    }
  }
  await flag.set({ date: now.date, finishedAt: new Date().toISOString(), users: refs.length, metricsDone, insights }, { merge: true });
}

export async function runInsightDeliveries(now: IsraelNow): Promise<number> {
  const dailyDue = inBucket(now.hm, "12:30");
  const weeklyDue = now.weekday === 0 && inBucket(now.hm, "20:00");
  if (!dailyDue && !weeklyDue) return 0;

  const links = await adminDb.collection("whatsappLinks").get();
  let sent = 0;
  for (const link of links.docs) {
    const uid = (link.data() as { uid: string }).uid;
    const phone = link.id;
    try {
      const user = adminDb.collection("users").doc(uid);
      const profile = (await user.collection("meta").doc("profile").get()).data() as UserProfile | undefined;
      if (!profile?.onboarded) continue;
      const deliveryRef = user.collection("meta").doc("insightDelivery");
      const delivery = ((await deliveryRef.get()).data() ?? {}) as { lastDailyDate?: string; lastWeeklyDate?: string };

      if (dailyDue && profile.insightPrefs?.dailyInsightWhatsapp !== false && delivery.lastDailyDate !== now.date) {
        const snap = await user.collection("insights").where("date", "==", now.date).get();
        const insight = snap.docs.map((d) => d.data() as Insight).find((i) => i.kind === "daily" && i.status !== "dismissed" && !i.whatsappSentAt);
        if (insight) {
          const msg = `${insight.title}\n${insight.body}`;
          await sendWhatsAppText(phone, msg);
          await user.collection("insights").doc(insight.id).set({ whatsappSentAt: new Date().toISOString() }, { merge: true });
          await deliveryRef.set({ lastDailyDate: now.date }, { merge: true });
          sent++;
        }
      }

      if (weeklyDue && profile.insightPrefs?.weeklyReviewWhatsapp !== false && delivery.lastWeeklyDate !== now.date) {
        const metrics = await computeMetrics(uid);
        const review = metrics ? await createWeeklyReview(uid, metrics, profile) : null;
        const weekly = review ?? ((await user.collection("insights").doc(`${now.date}-weekly`).get()).data() as Insight | undefined);
        if (weekly && !weekly.whatsappSentAt) {
          await sendWhatsAppText(phone, weekly.body);
          await user.collection("insights").doc(weekly.id).set({ whatsappSentAt: new Date().toISOString() }, { merge: true });
          await deliveryRef.set({ lastWeeklyDate: now.date }, { merge: true });
          sent++;
        }
      }
    } catch (err) {
      console.error("[insights] delivery failed for", uid, err);
    }
  }
  return sent;
}

/**
 * GET/POST /api/whatsapp/reminders
 * Auth: Firebase ID token (Bearer).
 *
 * Reads/writes the signed-in user's proactive WhatsApp reminder settings
 * (whatsappReminders/{uid} — see src/lib/types.ts's WhatsAppReminderSettings
 * and /api/cron/whatsapp-reminders, which is what actually sends them).
 * Requires a linked WhatsApp number (users/{uid}/meta/profile.whatsappPhone)
 * — there's nowhere to send a reminder otherwise.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getUidFromRequest } from "@/lib/auth";
import { adminDb } from "@/lib/firebase/admin";
import type { UserProfile, WhatsAppReminderSettings } from "@/lib/types";

const DEFAULTS: Omit<WhatsAppReminderSettings, "phone" | "lang" | "lastSent" | "updatedAt"> = {
  breakfastCheckIn: { enabled: false, time: "10:00" },
  middayCheckIn: { enabled: false, time: "15:00", thresholdPercent: 40 },
  eveningSummary: { enabled: false, time: "21:00" },
  morningRecap: { enabled: false, time: "08:00" },
  weeklyWeighIn: { enabled: false, time: "09:00" },
  customGoalsCheckIn: { enabled: false, time: "20:30" },
};

const reminderConfigSchema = z.object({ enabled: z.boolean(), time: z.string().regex(/^\d{2}:\d{2}$/) });

const bodySchema = z.object({
  breakfastCheckIn: reminderConfigSchema,
  middayCheckIn: reminderConfigSchema.extend({ thresholdPercent: z.number().min(0).max(100) }),
  eveningSummary: reminderConfigSchema,
  morningRecap: reminderConfigSchema,
  weeklyWeighIn: reminderConfigSchema,
  customGoalsCheckIn: reminderConfigSchema,
});

export async function GET(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const snap = await adminDb.collection("whatsappReminders").doc(uid).get();
  const data = snap.data() as WhatsAppReminderSettings | undefined;
  return NextResponse.json({
    breakfastCheckIn: data?.breakfastCheckIn ?? DEFAULTS.breakfastCheckIn,
    middayCheckIn: data?.middayCheckIn ?? DEFAULTS.middayCheckIn,
    eveningSummary: data?.eveningSummary ?? DEFAULTS.eveningSummary,
    morningRecap: data?.morningRecap ?? DEFAULTS.morningRecap,
    weeklyWeighIn: data?.weeklyWeighIn ?? DEFAULTS.weeklyWeighIn,
    customGoalsCheckIn: data?.customGoalsCheckIn ?? DEFAULTS.customGoalsCheckIn,
  });
}

export async function POST(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsedBody = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Invalid request", details: parsedBody.error.flatten() }, { status: 400 });
  }

  const profileSnap = await adminDb.collection("users").doc(uid).collection("meta").doc("profile").get();
  const profile = profileSnap.data() as UserProfile | undefined;
  if (!profile?.whatsappPhone) {
    return NextResponse.json({ error: "Link a WhatsApp number first" }, { status: 400 });
  }

  const ref = adminDb.collection("whatsappReminders").doc(uid);
  const existing = (await ref.get()).data() as WhatsAppReminderSettings | undefined;
  const settings: WhatsAppReminderSettings = {
    ...parsedBody.data,
    phone: profile.whatsappPhone,
    lang: profile.language ?? "he",
    lastSent: existing?.lastSent ?? {},
    updatedAt: new Date().toISOString(),
  };
  await ref.set(settings);

  return NextResponse.json({ ok: true });
}

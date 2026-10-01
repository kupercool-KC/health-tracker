/**
 * "manage_reminder" chat intent — create, list, or delete a user-defined
 * proactive WhatsApp reminder (the six built-in reminder types in Profile
 * are separate; this is for arbitrary ones the user describes in their own
 * words, e.g. "remind me every day at 8pm to drink water"). Delivery is
 * always via WhatsApp (see /api/cron/whatsapp-reminders), regardless of
 * whether the reminder was created from the web chat or from WhatsApp
 * itself — so creating one requires a linked number.
 */
import "server-only";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";
import { getOpenAIClient } from "@/lib/openai/client";
import type { ChatMessage, CustomReminder, UserProfile, WhatsAppReminderSettings } from "@/lib/types";

const WEEKDAY_NAMES_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_NAMES_HE = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

const parsedSchema = z.object({
  action: z.enum(["create", "list", "delete", "unclear"]),
  text: z.string().optional(),
  time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  recurrence: z.enum(["daily", "weekly"]).optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  matchText: z.string().optional(),
});

async function parseReminderRequest(
  message: string,
  history: ChatMessage[],
): Promise<z.infer<typeof parsedSchema>> {
  const historyMessages = history.slice(-6).map((m) => ({ role: m.role, content: m.content }) as const);
  const completion = await getOpenAIClient().chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    temperature: 0,
    messages: [
      {
        role: "system",
        content: `The user wants to manage a proactive WhatsApp reminder. Extract their intent as JSON:
{ "action": "create"|"list"|"delete"|"unclear", "text": string, "time": "HH:mm", "recurrence": "daily"|"weekly", "weekday": 0-6, "matchText": string }
- action "create": they described a NEW reminder to add. "text" is what the reminder message should say (short, imperative, in the SAME language they used — e.g. "Drink water" / "לשתות מים"). "time" is a 24h HH:mm best guess (e.g. "morning"→"08:00", "evening"→"20:00", "8pm"→"20:00"); if truly no time is stated, omit it. "recurrence" is "weekly" only if they named a specific day (e.g. "every Sunday"); otherwise "daily". "weekday" (0=Sunday..6=Saturday) only when recurrence is "weekly".
- action "list": they're asking what reminders they currently have.
- action "delete": they want to remove an existing reminder. "matchText" is a short phrase identifying which one (e.g. "water", "the Sunday one").
- action "unclear": genuinely ambiguous — missing a time for a create, or delete with nothing identifying which reminder.
Respond ONLY with that JSON object.`,
      },
      ...historyMessages,
      { role: "user", content: message },
    ],
  });
  const raw = completion.choices[0]?.message?.content;
  return parsedSchema.parse(JSON.parse(raw ?? "{}"));
}

async function loadOrInitSettings(uid: string): Promise<{ ref: FirebaseFirestore.DocumentReference; settings: WhatsAppReminderSettings | null }> {
  const ref = adminDb.collection("whatsappReminders").doc(uid);
  const snap = await ref.get();
  if (snap.exists) return { ref, settings: snap.data() as WhatsAppReminderSettings };

  // No settings doc yet — only create one on demand (a "create" action) if
  // the user actually has a linked number; list/delete on a nonexistent doc
  // just means "you have none", handled by the caller.
  return { ref, settings: null };
}

function formatReminder(r: CustomReminder, lang: "en" | "he"): string {
  if (r.recurrence === "weekly" && r.weekday != null) {
    const day = lang === "he" ? WEEKDAY_NAMES_HE[r.weekday] : WEEKDAY_NAMES_EN[r.weekday];
    return lang === "he" ? `${r.text} — ${day} ${r.time}` : `${r.text} — ${day}s ${r.time}`;
  }
  return lang === "he" ? `${r.text} — כל יום ${r.time}` : `${r.text} — daily ${r.time}`;
}

export async function resolveReminderAction(
  uid: string,
  message: string,
  lang: "en" | "he",
  history: ChatMessage[],
): Promise<{ replyContent: string }> {
  const parsed = await parseReminderRequest(message, history);

  if (parsed.action === "unclear") {
    return {
      replyContent:
        lang === "he"
          ? "באיזו שעה לשלוח את התזכורת, ומה לכתוב בה?"
          : "What time should I send it, and what should the reminder say?",
    };
  }

  if (parsed.action === "list") {
    const { settings } = await loadOrInitSettings(uid);
    const reminders = settings?.customReminders ?? [];
    if (reminders.length === 0) {
      return { replyContent: lang === "he" ? "אין לך תזכורות מותאמות אישית כרגע." : "You don't have any custom reminders yet." };
    }
    const lines = reminders.map((r) => `• ${formatReminder(r, lang)}`).join("\n");
    return { replyContent: lines };
  }

  if (parsed.action === "delete") {
    const { ref, settings } = await loadOrInitSettings(uid);
    const reminders = settings?.customReminders ?? [];
    const needle = (parsed.matchText ?? "").toLowerCase().trim();
    const match = needle ? reminders.find((r) => r.text.toLowerCase().includes(needle)) : undefined;
    if (!match) {
      return {
        replyContent: lang === "he" ? "לא מצאתי תזכורת שמתאימה לתיאור הזה." : "I couldn't find a reminder matching that.",
      };
    }
    const next = reminders.filter((r) => r.id !== match.id);
    await ref.set({ customReminders: next }, { merge: true });
    return {
      replyContent: lang === "he" ? `מחקתי: ${match.text}` : `Deleted: ${match.text}`,
    };
  }

  // action === "create"
  if (!parsed.text || !parsed.time) {
    return {
      replyContent:
        lang === "he"
          ? "באיזו שעה לשלוח את התזכורת, ומה לכתוב בה?"
          : "What time should I send it, and what should the reminder say?",
    };
  }

  const profileSnap = await adminDb.collection("users").doc(uid).collection("meta").doc("profile").get();
  const profile = profileSnap.data() as UserProfile | undefined;
  if (!profile?.whatsappPhone) {
    return {
      replyContent:
        lang === "he"
          ? "כדי ליצור תזכורות צריך קודם לקשר מספר WhatsApp — פרופיל ← קישור WhatsApp."
          : "To create reminders, link a WhatsApp number first — Profile → Link WhatsApp.",
    };
  }

  const { ref, settings } = await loadOrInitSettings(uid);
  const newReminder: CustomReminder = {
    id: crypto.randomUUID(),
    text: parsed.text,
    time: parsed.time,
    recurrence: parsed.recurrence ?? "daily",
    ...(parsed.recurrence === "weekly" && parsed.weekday != null ? { weekday: parsed.weekday } : {}),
    createdAt: new Date().toISOString(),
  };
  const existingReminders = settings?.customReminders ?? [];
  await ref.set(
    {
      phone: profile.whatsappPhone,
      lang: profile.language ?? lang,
      customReminders: [...existingReminders, newReminder],
      // Firestore requires every field present on first write of a doc that
      // didn't exist yet — merge:true with these as no-ops when it did.
      lastSent: settings?.lastSent ?? {},
    },
    { merge: true },
  );

  return { replyContent: lang === "he" ? `נשמר: ${formatReminder(newReminder, lang)}` : `Saved: ${formatReminder(newReminder, lang)}` };
}


export async function listCustomReminders(uid: string): Promise<CustomReminder[]> {
  const { settings } = await loadOrInitSettings(uid);
  return settings?.customReminders ?? [];
}

export async function createCustomReminder(
  uid: string,
  input: { text: string; intent: string; time: string; recurrence: "daily" | "weekly"; weekday?: number; lang: "en" | "he" },
): Promise<{ ok: true; reminder: CustomReminder } | { ok: false; error: string }> {
  const profileSnap = await adminDb.collection("users").doc(uid).collection("meta").doc("profile").get();
  const profile = profileSnap.data() as UserProfile | undefined;
  if (!profile?.whatsappPhone) return { ok: false, error: "No WhatsApp number is linked to this account (Profile → Link WhatsApp), so reminders can't be delivered." };

  const { ref, settings } = await loadOrInitSettings(uid);
  const reminder: CustomReminder = {
    id: crypto.randomUUID(),
    text: input.text,
    intent: input.intent,
    time: input.time,
    recurrence: input.recurrence,
    ...(input.recurrence === "weekly" && input.weekday != null ? { weekday: input.weekday } : {}),
    createdAt: new Date().toISOString(),
  };
  await ref.set(
    {
      phone: profile.whatsappPhone,
      lang: profile.language ?? input.lang,
      customReminders: [...(settings?.customReminders ?? []), reminder],
      lastSent: settings?.lastSent ?? {},
    },
    { merge: true },
  );
  return { ok: true, reminder };
}

export async function deleteCustomReminder(uid: string, idOrText: string): Promise<CustomReminder | null> {
  const { ref, settings } = await loadOrInitSettings(uid);
  const reminders = settings?.customReminders ?? [];
  const needle = idOrText.trim().toLowerCase();
  const match = reminders.find((r) => r.id === idOrText.trim()) ?? reminders.find((r) => (r.intent ?? r.text).toLowerCase().includes(needle));
  if (!match) return null;
  await ref.set({ customReminders: reminders.filter((r) => r.id !== match.id) }, { merge: true });
  return match;
}

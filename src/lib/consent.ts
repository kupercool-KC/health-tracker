/**
 * Explicit consent to send a user's data (messages, photos, voice, health entries)
 * to a third-party AI provider (OpenAI). App Store guideline 5.1.2(i) requires it
 * before any such request; GDPR/Israeli law want it for health-related data too.
 * Stored on users/{uid}/meta/profile as aiConsentAt (written by the in-app consent
 * screen). Enforcement on the server is OFF until appConfig/consent.enforce = true,
 * so existing users aren't locked out the moment this ships.
 */
import "server-only";
import { adminDb } from "@/lib/firebase/admin";

export const AI_CONSENT_VERSION = 1;

let cached: { at: number; enforce: boolean } | null = null;

async function isEnforced(): Promise<boolean> {
  if (cached && Date.now() - cached.at < 60_000) return cached.enforce;
  let enforce = false;
  try {
    const data = (await adminDb.collection("appConfig").doc("consent").get()).data() as { enforce?: boolean } | undefined;
    enforce = data?.enforce === true;
  } catch {
    // never lock users out because of a config read failure
  }
  cached = { at: Date.now(), enforce };
  return enforce;
}

/** True when the user may be sent to the AI provider (consented, or enforcement is off). */
export async function hasAiConsent(uid: string): Promise<boolean> {
  if (!(await isEnforced())) return true;
  const profile = (await adminDb.collection("users").doc(uid).collection("meta").doc("profile").get()).data() as { aiConsentAt?: string } | undefined;
  return !!profile?.aiConsentAt;
}

const NEED_CONSENT = {
  he: "לפני שנמשיך, צריך אישור שלך לשליחת ההודעות, התמונות וההקלטות שלך לעיבוד בינה מלאכותית (OpenAI). אפשר לאשר באפליקציה: פרופיל או מסך הכניסה.\nhttps://health-tracker-sepia.vercel.app",
  en: "Before we continue, I need your OK to send your messages, photos and voice notes to an AI provider (OpenAI) for processing. You can accept in the app: Profile or the sign-in screen.\nhttps://health-tracker-sepia.vercel.app",
} as const;

export function needConsentMessage(lang: "en" | "he"): string {
  return NEED_CONSENT[lang];
}

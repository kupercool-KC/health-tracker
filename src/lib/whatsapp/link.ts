/**
 * Maps a WhatsApp phone number to the health-tracker uid it's linked to.
 * Two records are kept in sync: whatsappLinks/{phone} -> uid (the direction
 * the webhook needs, O(1) lookup by incoming `from`) and
 * users/{uid}/meta/profile.whatsappPhone -> phone (the direction the Profile
 * screen needs, to show/edit the current link). whatsappLinks is a top-level,
 * server-only collection — see firestore.rules, no client rule matches it.
 */
import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";

/** Strips everything but digits — WhatsApp's own `from` field is already digits-only (E.164 without the leading "+"), so this also normalizes whatever a user types in Profile ("+972 50-240-6562" etc.) to match it. */
export function normalizePhone(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

export async function getUidForPhone(phone: string): Promise<string | null> {
  const snap = await adminDb.collection("whatsappLinks").doc(phone).get();
  const data = snap.data() as { uid: string } | undefined;
  return data?.uid ?? null;
}

export async function linkPhoneToUid(uid: string, phone: string): Promise<{ ok: true } | { ok: false; reason: "taken" }> {
  const ref = adminDb.collection("whatsappLinks").doc(phone);
  const existing = (await ref.get()).data() as { uid: string } | undefined;
  if (existing && existing.uid !== uid) return { ok: false, reason: "taken" };

  await ref.set({ uid, linkedAt: new Date().toISOString() });
  await adminDb.collection("users").doc(uid).collection("meta").doc("profile").set({ whatsappPhone: phone }, { merge: true });
  return { ok: true };
}

export async function unlinkPhone(uid: string, phone: string): Promise<void> {
  await adminDb.collection("whatsappLinks").doc(phone).delete();
  await adminDb
    .collection("users")
    .doc(uid)
    .collection("meta")
    .doc("profile")
    .set({ whatsappPhone: FieldValue.delete() }, { merge: true });
  // Nothing to send reminders to anymore — drop the settings doc rather than
  // leaving it around with a phone number that no longer belongs to this uid.
  await adminDb.collection("whatsappReminders").doc(uid).delete();
}

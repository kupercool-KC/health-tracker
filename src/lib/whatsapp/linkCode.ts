/**
 * Proves a WhatsApp number belongs to the signed-in user before linking it.
 * The user asks for a one-time code in the app, then SENDS it to the bot from
 * the number they want to link — so the incoming message's `from` (set by
 * WhatsApp, not user-typed) is the verified number. Replaces the old flow
 * where anyone could type any number and receive that person's messages.
 *
 * Collections (server-only, no client rule):
 *   whatsappLinkCodes/{code}      { uid, expiresAt }
 *   whatsappLinkAttempts/{phone}  { count, windowStart } — caps wrong guesses per sender
 */
import "server-only";
import crypto from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";
import { linkPhoneToUid } from "./link";

const CODE_TTL_MIN = 15;
const MAX_WRONG_GUESSES = 5;
const ATTEMPT_WINDOW_MS = 60 * 60 * 1000;

export async function createLinkCode(uid: string): Promise<{ code: string; expiresInMin: number }> {
  const col = adminDb.collection("whatsappLinkCodes");
  // One live code per user — a new request replaces the previous one.
  const old = await col.where("uid", "==", uid).get();
  await Promise.all(old.docs.map((d) => d.ref.delete()));
  const code = String(crypto.randomInt(0, 100_000_000)).padStart(8, "0");
  await col.doc(code).set({ uid, expiresAt: new Date(Date.now() + CODE_TTL_MIN * 60_000).toISOString() });
  return { code, expiresInMin: CODE_TTL_MIN };
}

/** The bot's own number, for the "send it to" wa.me link. Cached; null if it can't be fetched. */
let cachedBotNumber: string | null = null;
export async function getBotNumber(): Promise<string | null> {
  if (cachedBotNumber) return cachedBotNumber;
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  if (process.env.WHATSAPP_BOT_NUMBER) return (cachedBotNumber = process.env.WHATSAPP_BOT_NUMBER.replace(/\D/g, ""));
  if (!id || !token) return null;
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${id}?fields=display_phone_number`, { headers: { Authorization: `Bearer ${token}` } });
    const num = ((await res.json()) as { display_phone_number?: string }).display_phone_number;
    if (num) cachedBotNumber = num.replace(/\D/g, "");
  } catch {
    // fall through
  }
  return cachedBotNumber;
}

/** If `text` contains a valid live code, links `phone` to that code's uid. Returns the uid, or null (no code in the text / wrong / expired / too many guesses). */
export async function consumeLinkCode(phone: string, text: string): Promise<{ uid: string } | null> {
  const match = /(?<!\d)(\d{8})(?!\d)/.exec(text.replace(/[\s-]/g, ""));
  if (!match) return null;

  const attemptsRef = adminDb.collection("whatsappLinkAttempts").doc(phone);
  const attempts = (await attemptsRef.get()).data() as { count: number; windowStart: number } | undefined;
  const fresh = !attempts || Date.now() - attempts.windowStart > ATTEMPT_WINDOW_MS;
  if (!fresh && attempts!.count >= MAX_WRONG_GUESSES) return null;

  const codeRef = adminDb.collection("whatsappLinkCodes").doc(match[1]);
  const data = (await codeRef.get()).data() as { uid: string; expiresAt: string } | undefined;
  if (!data || Date.parse(data.expiresAt) < Date.now()) {
    await attemptsRef.set({ count: fresh ? 1 : attempts!.count + 1, windowStart: fresh ? Date.now() : attempts!.windowStart });
    return null;
  }

  const linked = await linkPhoneToUid(data.uid, phone);
  await codeRef.delete();
  return linked.ok ? { uid: data.uid } : null;
}

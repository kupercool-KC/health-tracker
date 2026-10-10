import "server-only";
import { adminDb } from "@/lib/firebase/admin";

/** Language the user actually writes to the bot in (last WhatsApp message), falling back to their stored language. */
export async function whatsappLang(uid: string, stored: "en" | "he"): Promise<"en" | "he"> {
  try {
    const sessionId = ((await adminDb.collection("users").doc(uid).collection("meta").doc("whatsapp").get()).data() as { sessionId?: string } | undefined)?.sessionId;
    if (!sessionId) return stored;
    const session = (await adminDb.collection("users").doc(uid).collection("chatSessions").doc(sessionId).get()).data() as { messages?: { role: string; content: string }[] } | undefined;
    const lastText = [...(session?.messages ?? [])].reverse().find((m) => m.role === "user" && /[A-Za-z֐-׿]{3}/.test(m.content));
    return lastText ? (/[֐-׿]/.test(lastText.content) ? "he" : "en") : stored;
  } catch {
    return stored;
  }
}

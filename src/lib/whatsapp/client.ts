/**
 * Thin wrapper around the WhatsApp Cloud API (Graph API) — sending a text
 * reply and downloading an incoming media attachment. Credentials come from
 * the WHATSAPP_TOKEN (permanent System User token) and
 * WHATSAPP_PHONE_NUMBER_ID env vars set up in Meta's developer console.
 */
import "server-only";

const GRAPH_VERSION = "v21.0";

function graphUrl(path: string): string {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${path}`;
}

/**
 * WhatsApp aligns each line by its first strong character, so a Hebrew line
 * that starts with a digit, "(" or Latin text renders left-aligned; a
 * leading RLM (U+200F) forces every Hebrew line to start right-to-left.
 *
 * A Hebrew line with more than one number/Latin run (e.g. "\u05DB\u05D5\u05EA\u05E8\u05EA: 150 kcal,
 * 20 \u05D2\u05E8\u05DD \u05D7\u05DC\u05D1\u05D5\u05DF", or "90 min, 550 kcal") has a second bidi problem:
 * the bidi algorithm can swap the visual order of separate LTR runs sitting
 * inside one RTL line. Isolating each individual token (U+2066 LRI \u2026
 * U+2069 PDI) is NOT enough to fix this \u2014 tokens separated only by spaces
 * (a neutral character with no direction of its own) can still be
 * reordered relative to each other, since an isolate carries no directional
 * "glue" to its neighbor. The actual fix is to isolate each *maximal* run
 * of Latin/digit content as ONE block \u2014 e.g. the whole "90 min, 550 kcal"
 * together, not "90", "min,", "550", "kcal" separately \u2014 so there's nothing
 * left for the algorithm to reorder within it.
 */
function isolateLtrRuns(line: string): string {
  return line.replace(/[A-Za-z0-9][A-Za-z0-9\s.,:%/'-]*[A-Za-z0-9%]|[A-Za-z0-9]/g, (run) => `\u2066${run}\u2069`);
}

function forceRtlLines(body: string): string {
  if (!/[\u0590-\u05FF]/.test(body)) return body;
  return body
    .split("\n")
    .map((line) => (line.trim() ? `\u200F${isolateLtrRuns(line)}` : line))
    .join("\n");
}

/** Best-effort — a failed send just means the user doesn't get a reply, not worth throwing and failing the whole webhook. */
export async function sendWhatsAppText(to: string, body: string, replyToId?: string): Promise<string | null> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  if (!phoneNumberId || !token) {
    console.error("[whatsapp] WHATSAPP_PHONE_NUMBER_ID/WHATSAPP_TOKEN not configured");
    return null;
  }
  const res = await fetch(graphUrl(`${phoneNumberId}/messages`), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: forceRtlLines(body) }, ...(replyToId ? { context: { message_id: replyToId } } : {}) }),
  }).catch((err) => {
    console.error("[whatsapp] send request failed:", err);
    return null;
  });
  if (res && !res.ok) {
    console.error("[whatsapp] send failed:", res.status, await res.text().catch(() => ""));
    return null;
  }
  const json = (await res?.json().catch(() => null)) as { messages?: { id?: string }[] } | null;
  return json?.messages?.[0]?.id ?? null;
}

export interface WhatsAppButton {
  id: string;
  title: string; // max 20 chars
}

/** A message with up to 3 quick-reply buttons (only valid inside the 24h window — always true for replies). Returns null when it can't be sent as buttons (too long / failed) so the caller can fall back to plain text. */
export async function sendWhatsAppButtons(to: string, body: string, buttons: readonly WhatsAppButton[]): Promise<string | null> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  if (!phoneNumberId || !token) return null;
  const text = forceRtlLines(body);
  if (text.length > 1024) return null;
  const res = await fetch(graphUrl(`${phoneNumberId}/messages`), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text },
        action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) },
      },
    }),
  }).catch((err) => {
    console.error("[whatsapp] buttons request failed:", err);
    return null;
  });
  if (!res || !res.ok) {
    console.error("[whatsapp] buttons send failed:", res?.status, await res?.text().catch(() => ""));
    return null;
  }
  const json = (await res.json().catch(() => null)) as { messages?: { id?: string }[] } | null;
  return json?.messages?.[0]?.id ?? null;
}

/**
 * Marks the incoming message read and shows the "typing…" indicator in the
 * user's WhatsApp thread — the only feedback WhatsApp offers while we're
 * off doing the OpenAI classify/parse round-trip, standing in for the web
 * chat's bouncing-dots "thinking" bubble. Auto-expires after ~25s or as soon
 * as we actually send a reply, whichever comes first — so this only needs
 * calling once, right when a message comes in, not kept alive with retries.
 * Best-effort: a failure here shouldn't block answering the message.
 */
export async function showTypingIndicator(messageId: string): Promise<void> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  if (!phoneNumberId || !token) return;
  const res = await fetch(graphUrl(`${phoneNumberId}/messages`), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId, typing_indicator: { type: "text" } }),
  }).catch((err) => {
    console.error("[whatsapp] typing indicator request failed:", err);
    return null;
  });
  if (res && !res.ok) {
    console.error("[whatsapp] typing indicator failed:", res.status, await res.text().catch(() => ""));
  }
}

/**
 * WhatsApp media isn't a plain public URL — it's a two-step fetch (look up a
 * short-lived download URL by media id, then fetch that URL, both
 * authenticated with the same token) that returns the raw bytes.
 */
export async function downloadWhatsAppMedia(mediaId: string): Promise<{ buffer: Buffer; contentType: string }> {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) throw new Error("WHATSAPP_TOKEN not configured");

  const metaRes = await fetch(graphUrl(mediaId), { headers: { Authorization: `Bearer ${token}` } });
  if (!metaRes.ok) throw new Error(`Failed to look up media ${mediaId}: ${metaRes.status}`);
  const meta = (await metaRes.json()) as { url: string; mime_type: string };

  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!fileRes.ok) throw new Error(`Failed to download media ${mediaId}: ${fileRes.status}`);

  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { buffer, contentType: meta.mime_type };
}

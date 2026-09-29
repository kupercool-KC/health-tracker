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

/** Best-effort — a failed send just means the user doesn't get a reply, not worth throwing and failing the whole webhook. */
export async function sendWhatsAppText(to: string, body: string): Promise<void> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  if (!phoneNumberId || !token) {
    console.error("[whatsapp] WHATSAPP_PHONE_NUMBER_ID/WHATSAPP_TOKEN not configured");
    return;
  }
  const res = await fetch(graphUrl(`${phoneNumberId}/messages`), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
  }).catch((err) => {
    console.error("[whatsapp] send request failed:", err);
    return null;
  });
  if (res && !res.ok) {
    console.error("[whatsapp] send failed:", res.status, await res.text().catch(() => ""));
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

/**
 * Shared speech-to-text helper — same Whisper call /api/transcribe uses for
 * the web chat's voice recorder, reused here so a WhatsApp voice note goes
 * through the identical model/settings and lands as plain text in the exact
 * same pipeline as a typed message.
 */
import "server-only";
import { toFile } from "openai";
import { getOpenAIClient } from "@/lib/openai/client";

// whisper-1 is universally available and cheap; override via env to try a
// newer model (e.g. gpt-4o-mini-transcribe) without a redeploy.
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "whisper-1";

/** OpenAI needs a filename whose extension it recognises — derive one from the blob's mime type. */
function extForType(type: string): string {
  if (type.includes("mp4") || type.includes("m4a") || type.includes("mpeg")) return "mp4";
  if (type.includes("ogg")) return "ogg";
  if (type.includes("wav")) return "wav";
  return "webm";
}

export async function transcribeAudio(buffer: Buffer, contentType: string, lang?: "en" | "he"): Promise<string> {
  const file = await toFile(buffer, `recording.${extForType(contentType)}`, { type: contentType });
  const result = await getOpenAIClient().audio.transcriptions.create({
    file,
    model: TRANSCRIBE_MODEL,
    language: lang,
    // A meal/exercise log is short and factual — keep the model from
    // "completing" a half-heard phrase into something unsaid.
    temperature: 0,
  });
  return (result.text ?? "").trim();
}

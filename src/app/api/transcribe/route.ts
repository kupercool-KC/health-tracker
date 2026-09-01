/**
 * POST /api/transcribe
 * Body: multipart/form-data — `audio` (a recorded clip) + optional `lang` ("en" | "he").
 * Auth: Firebase ID token (Bearer).
 *
 * Speech-to-text only. Turns a spoken meal/workout/steps description into
 * plain text; the client then feeds that text through the normal
 * /api/nutrition (or /api/chat) path. Kept separate from parsing so the
 * transcript can be shown for review/edit before anything is logged.
 */
import { NextResponse } from "next/server";
import { toFile } from "openai";
import { getUidFromRequest } from "@/lib/auth";
import { getOpenAIClient } from "@/lib/openai/client";

export const runtime = "nodejs";

// Whisper's hard limit is 25 MB. A ~60s Opus/AAC clip is well under 1 MB, so
// anything near this ceiling is either an over-long recording or not audio.
const MAX_BYTES = 25 * 1024 * 1024;

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

export async function POST(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const audio = form.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) {
    return NextResponse.json({ error: "Missing audio" }, { status: 400 });
  }
  if (audio.size > MAX_BYTES) {
    return NextResponse.json({ error: "Recording too large" }, { status: 413 });
  }

  const langRaw = form.get("lang");
  const language = langRaw === "he" ? "he" : langRaw === "en" ? "en" : undefined;

  const type = audio.type || "audio/webm";

  try {
    const buf = Buffer.from(await audio.arrayBuffer());
    const file = await toFile(buf, `recording.${extForType(type)}`, { type });
    const result = await getOpenAIClient().audio.transcriptions.create({
      file,
      model: TRANSCRIBE_MODEL,
      language,
      // A meal/exercise log is short and factual — keep the model from
      // "completing" a half-heard phrase into something unsaid.
      temperature: 0,
    });
    const text = (result.text ?? "").trim();
    if (!text) return NextResponse.json({ error: "No speech detected" }, { status: 422 });
    return NextResponse.json({ text }, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: "Transcription failed", detail: String(err instanceof Error ? err.message : err) },
      { status: 502 },
    );
  }
}

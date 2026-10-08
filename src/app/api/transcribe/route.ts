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
import { getUidFromRequest } from "@/lib/auth";
import { transcribeAudio } from "@/lib/openai/transcribe";
import { hasAiConsent } from "@/lib/consent";

export const runtime = "nodejs";

// Whisper's hard limit is 25 MB. A ~60s Opus/AAC clip is well under 1 MB, so
// anything near this ceiling is either an over-long recording or not audio.
const MAX_BYTES = 25 * 1024 * 1024;

export async function POST(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await hasAiConsent(uid))) return NextResponse.json({ error: "AI processing consent required" }, { status: 403 });

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
    const text = await transcribeAudio(buf, type, language);
    if (!text) return NextResponse.json({ error: "No speech detected" }, { status: 422 });
    return NextResponse.json({ text }, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: "Transcription failed", detail: String(err instanceof Error ? err.message : err) },
      { status: 502 },
    );
  }
}

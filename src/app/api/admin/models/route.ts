/**
 * GET /api/admin/models
 * Lists OpenAI chat/vision-capable model ids for the admin config dropdown.
 * Auth: Firebase ID token (Bearer), restricted to ADMIN_UID.
 */
import { NextResponse } from "next/server";
import OpenAI from "openai";
import { getUidFromRequest } from "@/lib/auth";
import { isAdmin } from "@/lib/admin";

// Excludes non-chat model families (audio, image, embeddings, moderation,
// legacy completion-only models) that would error if picked for our
// chat.completions call in src/lib/nutrition/parser.ts.
const EXCLUDE_PATTERNS = [
  "whisper",
  "tts",
  "dall-e",
  "embedding",
  "moderation",
  "davinci",
  "babbage",
  "ada",
  "curie",
  "instruct",
  "audio",
  "realtime",
  "transcribe",
  "image",
  "search",
];

export async function GET(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid || !isAdmin(uid)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const list = await client.models.list();

  const models = list.data
    .map((m) => m.id)
    .filter((id) => !EXCLUDE_PATTERNS.some((p) => id.includes(p)))
    .sort();

  return NextResponse.json({ models });
}

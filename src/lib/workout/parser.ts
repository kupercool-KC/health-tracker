/**
 * Manual workout parsing: turn a text description and/or a screenshot of a
 * workout summary (fitness app, smartwatch, treadmill display, etc.) into
 * structured metrics. Mirrors src/lib/nutrition/parser.ts's shape/approach —
 * server-only, uses the OpenAI key — but keeps its prompt/model hardcoded
 * rather than admin-configurable, since this is a lower-traffic path than
 * nutrition parsing and doesn't yet need runtime tuning.
 */
import "server-only";
import type OpenAI from "openai";
import { z } from "zod";
import type { ParsedWorkout } from "@/lib/types";
import { getOpenAIClient } from "@/lib/openai/client";

const parsedSchema = z.object({
  type: z.string().min(1),
  durationSec: z.number().nonnegative(),
  distanceMeters: z.number().nonnegative().optional(),
  paceSecPerKm: z.number().nonnegative().optional(),
  calories: z.number().nonnegative().optional(),
  heartRateAvg: z.number().positive().optional(),
  heartRateMax: z.number().positive().optional(),
  elevationGainMeters: z.number().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export interface ParseWorkoutInput {
  /** Free-text description from the workout-log box. Optional if an image is provided. */
  text?: string;
  /** A data URL or https URL for a screenshot of a workout summary. Optional. */
  imageUrl?: string;
  /** Language the "type" field should be written in. Defaults to English. */
  lang?: "en" | "he";
}

const SYSTEM_PROMPT = `You are a workout log estimator. Given a text description of a workout and/or
a screenshot of a workout summary (from a fitness app, smartwatch, gym machine display, etc.),
extract the key metrics for that single workout session.

Respond ONLY with JSON matching:
{ "type": string, "durationSec": number, "distanceMeters": number, "paceSecPerKm": number, "calories": number, "heartRateAvg": number, "heartRateMax": number, "elevationGainMeters": number, "confidence": number }
- type: a short workout type/name (e.g. "Running", "Strength Training", "Cycling", "Yoga", "HIIT").
- durationSec: total duration in seconds — required. Estimate from context if not stated exactly
  (e.g. "about an hour at the gym" → 3600).
- distanceMeters, paceSecPerKm, calories, heartRateAvg, heartRateMax, elevationGainMeters: include
  your best estimate for any that are shown or mentioned; omit fields that don't apply (e.g. no
  distance/pace for a strength-training session).
- confidence: your confidence in the overall estimate from 0 to 1.
If the input is ambiguous, make a reasonable single best estimate rather than refusing.`;

export async function parseWorkout(input: ParseWorkoutInput): Promise<ParsedWorkout> {
  if (!input.text && !input.imageUrl) {
    throw new Error("parseWorkout requires text or imageUrl");
  }

  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  if (input.text) content.push({ type: "text", text: input.text });
  if (input.imageUrl) {
    content.push({ type: "image_url", image_url: { url: input.imageUrl } });
  }

  const languageInstruction =
    input.lang === "he"
      ? "\n\nWrite the \"type\" field in Hebrew, regardless of what language the input is in."
      : "\n\nWrite the \"type\" field in English, regardless of what language the input is in.";

  const completion = await getOpenAIClient().chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT + languageInstruction },
      { role: "user", content },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("Empty response from workout parser");

  return parsedSchema.parse(JSON.parse(raw));
}

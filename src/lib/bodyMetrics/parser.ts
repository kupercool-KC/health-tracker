/**
 * Weigh-in parsing: turn one or more screenshots of a smart scale's app
 * (weight, BMI, muscle mass, body fat %, visceral fat, body water %, basal
 * metabolic rate, protein %) into structured readings. Mirrors
 * src/lib/workout/parser.ts's shape/approach — server-only, uses the
 * OpenAI key, one hardcoded prompt/model (low-traffic, weekly use).
 */
import "server-only";
import type OpenAI from "openai";
import { z } from "zod";
import type { ParsedBodyMetrics } from "@/lib/types";
import { getOpenAIClient } from "@/lib/openai/client";

const parsedSchema = z.object({
  weightKg: z.number().positive().optional(),
  bmi: z.number().positive().optional(),
  muscleMassKg: z.number().positive().optional(),
  bodyFatPercent: z.number().nonnegative().optional(),
  visceralFat: z.number().nonnegative().optional(),
  bodyWaterPercent: z.number().nonnegative().optional(),
  basalMetabolicRate: z.number().positive().optional(),
  proteinPercent: z.number().nonnegative().optional(),
});

export interface ParseBodyMetricsInput {
  /** Free-text accompanying the screenshot(s), if any. Optional if imageUrls are provided. */
  text?: string;
  /** Data URLs or https URLs for the scale app's screenshot(s) — often several, one metric highlighted per screen. */
  imageUrls?: string[];
  /** Recent chat turns preceding this message — same role as in nutrition/workout parsers. */
  history?: { role: "user" | "assistant"; content: string }[];
}

const SYSTEM_PROMPT = `You are reading screenshots from a smart bathroom scale's companion app (e.g. Renpho,
Eufy, Withings) after a weigh-in. One or more screenshots may be provided, each possibly showing a
different subset of metrics (apps like this often spread the readings across several screens/cards).
Combine everything visible across ALL provided images into a single set of readings for this one
weigh-in.

Respond ONLY with JSON matching:
{ "weightKg": number, "bmi": number, "muscleMassKg": number, "bodyFatPercent": number, "visceralFat": number, "bodyWaterPercent": number, "basalMetabolicRate": number, "proteinPercent": number }

- weightKg: body weight in kilograms. If the screenshot shows lb, convert to kg (divide by 2.20462).
- bmi: as shown.
- muscleMassKg: muscle mass in kilograms (may be labeled "Muscle", "Muscle mass", "SMM").
- bodyFatPercent: body fat percentage (may be labeled "Body fat", "Fat %", "PBF").
- visceralFat: visceral fat rating/index — usually a small unitless number (e.g. 5, 8), not a percent.
- bodyWaterPercent: body water percentage (may be labeled "Water", "TBW").
- basalMetabolicRate: basal metabolic rate in kcal (may be labeled "BMR", "Basal metabolism").
- proteinPercent: protein percentage (may be labeled "Protein").

Omit any field that isn't visible anywhere in the provided screenshots — never guess or invent a
number for a metric you can't actually see. If nothing readable is found at all, return {}.`;

export async function parseBodyMetrics(input: ParseBodyMetricsInput): Promise<ParsedBodyMetrics> {
  if (!input.text && !input.imageUrls?.length) {
    throw new Error("parseBodyMetrics requires text or imageUrls");
  }

  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  if (input.text) content.push({ type: "text", text: input.text });
  for (const url of input.imageUrls ?? []) {
    content.push({ type: "image_url", image_url: { url } });
  }

  const historyMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = (input.history ?? [])
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.content }));
  const historyInstruction =
    historyMessages.length > 0
      ? "\n\nRecent conversation turns are included before the final message for context."
      : "";

  const completion = await getOpenAIClient().chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT + historyInstruction },
      ...historyMessages,
      { role: "user", content },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("Empty response from body-metrics parser");

  return parsedSchema.parse(JSON.parse(raw));
}

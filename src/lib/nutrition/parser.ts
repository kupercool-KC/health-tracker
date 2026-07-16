/**
 * Nutrition parsing: turn a chat message and/or a food image into structured
 * { description, calories, protein }. Server-only — uses the OpenAI key.
 *
 * The provider lives behind the `parseNutrition` function so it can be swapped
 * later without touching the API routes.
 */
import "server-only";
import OpenAI from "openai";
import { z } from "zod";
import type { ParsedNutrition } from "@/lib/types";

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o";

// Lazily constructed so importing this module (e.g. during `next build`'s
// route data collection) doesn't require OPENAI_API_KEY to be set yet.
let client: OpenAI | undefined;
function getClient(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

const parsedSchema = z.object({
  description: z.string().min(1),
  calories: z.number().nonnegative(),
  protein: z.number().nonnegative(),
  confidence: z.number().min(0).max(1).optional(),
});

const SYSTEM_PROMPT = `You are a nutrition estimator. Given a text description and/or a photo of food,
estimate the total calories (kcal) and protein (grams) for the portion shown.
Respond ONLY with JSON matching:
{ "description": string, "calories": number, "protein": number, "confidence": number }
- description: a short human summary of what was logged.
- confidence: your confidence in the estimate from 0 to 1.
If the input is ambiguous, make a reasonable single best estimate rather than refusing.`;

export interface ParseInput {
  /** Free-text message from the chat box. Optional if an image is provided. */
  text?: string;
  /** A data URL or https URL for the food photo. Optional. */
  imageUrl?: string;
}

export async function parseNutrition(input: ParseInput): Promise<ParsedNutrition> {
  if (!input.text && !input.imageUrl) {
    throw new Error("parseNutrition requires text or imageUrl");
  }

  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  if (input.text) content.push({ type: "text", text: input.text });
  if (input.imageUrl) {
    content.push({ type: "image_url", image_url: { url: input.imageUrl } });
  }

  const completion = await getClient().chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("Empty response from nutrition parser");

  return parsedSchema.parse(JSON.parse(raw));
}

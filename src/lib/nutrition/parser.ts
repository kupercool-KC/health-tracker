/**
 * Nutrition parsing: turn a chat message and/or a food image into structured
 * { description, calories, protein }. Server-only — uses the OpenAI key.
 *
 * The provider lives behind the `parseNutrition` function so it can be swapped
 * later without touching the API routes. System prompt / model / sampling
 * params are editable at runtime from /admin (see ./config.ts) instead of
 * hardcoded here.
 */
import "server-only";
import type OpenAI from "openai";
import { z } from "zod";
import type { ParsedNutrition } from "@/lib/types";
import { getNutritionParserConfig } from "./config";
import { getOpenAIClient } from "@/lib/openai/client";

const parsedSchema = z.object({
  description: z.string().min(1),
  calories: z.number().nonnegative(),
  protein: z.number().nonnegative(),
  carbs: z.number().nonnegative().optional(),
  fat: z.number().nonnegative().optional(),
  fiber: z.number().nonnegative().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

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

  const config = await getNutritionParserConfig();

  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  if (input.text) content.push({ type: "text", text: input.text });
  if (input.imageUrl) {
    content.push({ type: "image_url", image_url: { url: input.imageUrl } });
  }

  const completion = await getOpenAIClient().chat.completions.create({
    model: config.model,
    response_format: { type: "json_object" },
    // Minimize run-to-run variance for the same input. Not a hard guarantee
    // of determinism (OpenAI notes seed/temperature reduce but don't
    // eliminate drift, especially across model version changes), but this
    // is the closest the API gets.
    temperature: config.temperature,
    seed: config.seed,
    messages: [
      { role: "system", content: config.systemPrompt },
      { role: "user", content },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("Empty response from nutrition parser");

  return parsedSchema.parse(JSON.parse(raw));
}

/**
 * Manual step-count parsing: turn a text description ("about 8500 steps
 * today") and/or a screenshot of a phone's health/fitness app into a single
 * number. Mirrors src/lib/workout/parser.ts's shape/approach.
 */
import "server-only";
import type OpenAI from "openai";
import { z } from "zod";
import type { ParsedSteps } from "@/lib/types";
import { getOpenAIClient } from "@/lib/openai/client";

const parsedSchema = z.object({
  steps: z.number().nonnegative(),
  confidence: z.number().min(0).max(1).optional(),
});

export interface ParseStepsInput {
  /** Free-text description, e.g. "8500 steps". Optional if an image is provided. */
  text?: string;
  /** A data URL or https URL for a screenshot of a step count. Optional. */
  imageUrl?: string;
  /** Recent chat turns preceding this message — see the same field on nutrition/parser.ts's ParseInput. */
  history?: { role: "user" | "assistant"; content: string }[];
}

const SYSTEM_PROMPT = `You are a step-count extractor. Given a text description and/or a screenshot of a
phone's health/fitness app (Apple Health, Google Fit, a smartwatch app, etc.), extract the single
total step count being reported for one day.

Respond ONLY with JSON matching: { "steps": number, "confidence": number }
- steps: the total step count as a whole number.
- confidence: your confidence in the reading from 0 to 1.
If the input is ambiguous (e.g. a range), make a reasonable single best estimate rather than refusing.`;

export async function parseSteps(input: ParseStepsInput): Promise<ParsedSteps> {
  if (!input.text && !input.imageUrl) {
    throw new Error("parseSteps requires text or imageUrl");
  }

  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  if (input.text) content.push({ type: "text", text: input.text });
  if (input.imageUrl) {
    content.push({ type: "image_url", image_url: { url: input.imageUrl } });
  }

  const historyMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = (input.history ?? [])
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.content }));
  const historyInstruction =
    historyMessages.length > 0
      ? "\n\nRecent conversation turns are included before the final message for context — if that final message doesn't itself state a step count (e.g. it's just \"add it\"/\"log that\"), figure out which count was being discussed and extract that instead of failing."
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
  if (!raw) throw new Error("Empty response from steps parser");

  return parsedSchema.parse(JSON.parse(raw));
}

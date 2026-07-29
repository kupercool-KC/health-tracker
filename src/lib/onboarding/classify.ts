/**
 * Maps a user's freeform "other" description (onboarding workout types /
 * dietary preferences) onto the app's existing enum categories, so typing
 * "I do pilates and climbing" during onboarding can auto-select the closest
 * real categories instead of leaving everything bucketed under "other".
 * Works in either language — the model isn't told which language the input
 * is in, just matched against the category list as given.
 */
import "server-only";
import { z } from "zod";
import { getOpenAIClient } from "@/lib/openai/client";

const CHAT_MODEL = "gpt-4o-mini";

export interface Category {
  value: string;
  label: string;
}

const resultSchema = z.object({ matched: z.array(z.string()) });

export async function classifyFreeText(text: string, categories: Category[]): Promise<string[]> {
  const completion = await getOpenAIClient().chat.completions.create({
    model: CHAT_MODEL,
    response_format: { type: "json_object" },
    temperature: 0,
    messages: [
      {
        role: "system",
        content: `The user wrote a freeform description (in any language) of something (a workout type or a
dietary preference). Here are the available categories as JSON: ${JSON.stringify(categories)}

Return every category whose "value" reasonably matches something in the description — zero, one, or
several are all valid (e.g. "pilates and rock climbing" might match none well if there's no close
category, "vegetarian but no dairy" should match both a vegetarian-like and a lactose-free-like
category if present). Don't force a match if nothing fits.

Respond ONLY as JSON: { "matched": string[] } — an array of "value"s from the list above.`,
      },
      { role: "user", content: text },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  try {
    const parsed = resultSchema.parse(JSON.parse(raw));
    const validValues = new Set(categories.map((c) => c.value));
    return parsed.matched.filter((v) => validValues.has(v));
  } catch {
    return [];
  }
}

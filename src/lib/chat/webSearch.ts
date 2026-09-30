/**
 * General-purpose web search for answerGeneralHealth — lets the assistant
 * look up an actual restaurant's menu, a specific dish, or other real-world
 * fact it has no other way to know, instead of always falling back to a
 * generic estimate. Uses OpenAI's hosted web_search_preview tool (same
 * mechanism as webSearchNutrition in nutrition/usda.ts, which is narrowly
 * scoped to a per-100g calories/protein number) but returns free-form text
 * since a "what's on their menu" question isn't reducible to one number.
 */
import "server-only";
import { getOpenAIClient } from "@/lib/openai/client";

export async function searchWeb(query: string): Promise<string | null> {
  try {
    const response = await getOpenAIClient().responses.create({
      model: "gpt-4o-mini",
      tools: [{ type: "web_search_preview" }],
      input: `Search the web and answer concisely, citing what you actually found (not general knowledge): ${query}`,
    });
    const text = response.output_text?.trim();
    return text || null;
  } catch {
    return null;
  }
}

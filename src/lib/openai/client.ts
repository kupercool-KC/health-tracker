/**
 * Shared lazily-constructed OpenAI client — lazy so importing this module
 * (e.g. during `next build`'s route data collection) doesn't require
 * OPENAI_API_KEY to be set yet. Used by the nutrition parser, the admin
 * model list, and chat.
 */
import "server-only";
import OpenAI from "openai";

let client: OpenAI | undefined;

export function getOpenAIClient(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

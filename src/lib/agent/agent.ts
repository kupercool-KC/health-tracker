/**
 * The single chat agent: one model call loop with tools and an explicit
 * per-turn state, replacing the old chain of ~12 independent classifiers.
 * Pure of session persistence — runAgentChatTurn (runAgentChatTurn.ts) wraps
 * it with Firestore; evals call runAgent directly with an in-memory
 * conversation.
 */
import "server-only";
import type OpenAI from "openai";
import { getOpenAIClient } from "@/lib/openai/client";
import { buildSystemPrompt } from "./prompt";
import { isDraftEmpty, renderDraft, renderState, type AgentState, type Draft } from "./state";
import { TOOL_BY_NAME, TOOL_DEFS, type TurnContext } from "./tools";
import type { ChatMessage } from "@/lib/types";

export const AGENT_MODEL = process.env.AGENT_MODEL || "gpt-4.1-mini";
const FALLBACK_MODEL = "gpt-4.1-mini"; // separate rate-limit bucket from gpt-4.1
const MAX_TOOL_ROUNDS = 8;
const CLAIMS_ACTION = /הכנסתי|רשמתי|הוספתי|תיעדתי|שמרתי|הכנתי|שמתי|עדכנתי|מחקתי|תיקנתי|סימנתי|סידרתי|הפעלתי|כיביתי|הגדרתי|קבעתי|מתקנ|אתקן|אעדכן|מעביר|מעדכנ|שיניתי|משנ|מוסיפ|\b(fixed|corrected|changed|logged|added|recorded|saved|updated|deleted)\b/i;
// The agent can never save anything itself, so a reply saying it did (while a draft is open) is a hallucination — seen live: "הפריטים נשמרו!" for items that were still waiting.
const CLAIMS_SAVED = /(?<!לא )(?<!עדיין לא )נשמר|(has|have) been saved|saved (it|them|those)/i;
const HISTORY_MESSAGES = 16;

export interface AgentInput {
  uid: string;
  lang: "en" | "he";
  today: string;
  userMessage: string;
  imageUrls?: string[];
  /** Conversation before this message (oldest first). */
  priorMessages: ChatMessage[];
  state: AgentState;
  /** Draft carried over from the latest open proposal. */
  draft: Draft;
  dryRun?: boolean;
}

export interface AgentOutput {
  replyContent: string;
  draft: Draft;
  mistakeFlagged: boolean;
  toolCalls: { name: string; args: unknown }[];
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .trim();
}

/** Last line of defence for the one thing that must never be wrong: a proposal's numbers must be visible to the user. */
function ensureNumbersShown(text: string, draft: Draft, lang: "en" | "he"): string {
  const digits = text.replace(/[,\s]/g, "");
  const missing: string[] = [];
  if (draft.meal) {
    for (const it of draft.meal.items) {
      if (!digits.includes(String(Math.round(it.calories)))) {
        missing.push(`${it.description}: ${Math.round(it.calories)} kcal, ${Math.round(it.protein)}${lang === "he" ? " גרם חלבון" : "g protein"}`);
      }
    }
  }
  if (draft.workout?.calories != null && !digits.includes(String(Math.round(draft.workout.calories)))) {
    const w = draft.workout;
    missing.push(`${w.type}: ${Math.round(w.durationSec / 60)} min${w.distanceMeters != null ? `, ${(w.distanceMeters / 1000).toFixed(1)} km` : ""}, ${Math.round(w.calories ?? 0)} kcal`);
  }
  if (draft.steps && !digits.includes(String(draft.steps.steps))) missing.push(`${draft.steps.steps} ${lang === "he" ? "צעדים" : "steps"}`);
  return missing.length ? `${text}\n\n${missing.join("\n")}` : text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The org's gpt-4.1 TPM cap (30k) is easy to hit when several WhatsApp messages land within a minute. Wait out a short 429 once; if still limited, use the mini model rather than dropping to the legacy pipeline. */
async function createCompletion(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const call = (model: string) => getOpenAIClient().chat.completions.create({ model, temperature: 0.4, messages, tools: TOOL_DEFS });
  try {
    return await call(AGENT_MODEL);
  } catch (err) {
    if ((err as { status?: number }).status !== 429) throw err;
    const wait = Number(/try again in ([\d.]+)s/i.exec((err as Error).message ?? "")?.[1]);
    if (Number.isFinite(wait) && wait <= 10) {
      await sleep((wait + 0.5) * 1000);
      try {
        return await call(AGENT_MODEL);
      } catch (err2) {
        if ((err2 as { status?: number }).status !== 429) throw err2;
      }
    }
    return call(FALLBACK_MODEL);
  }
}

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const ctx: TurnContext = {
    uid: input.uid,
    lang: input.lang,
    today: input.today,
    userMessage: input.userMessage,
    imageUrls: input.imageUrls,
    priorMessages: input.priorMessages,
    state: input.state,
    draft: input.draft,
    dryRun: input.dryRun,
  };

  const history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = input.priorMessages
    .slice(-HISTORY_MESSAGES)
    .map(
      (m) =>
        ({
          role: m.role,
          // A confirmed proposal still reads "…לאשר?" in its text — say plainly it was saved, or the model keeps calling it a draft.
          content: m.confirmedAt ? `${m.content}\n[SYSTEM NOTE: the user CONFIRMED this proposal and it is now SAVED in the log — it is no longer a draft.]` : m.content,
        }) as OpenAI.Chat.Completions.ChatCompletionMessageParam,
    );

  const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: "text", text: input.userMessage || (input.lang === "he" ? "[תמונה]" : "[photo]") }];
  for (const url of input.imageUrls ?? []) userContent.push({ type: "image_url", image_url: { url } });

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(input.lang, input.state.profile?.gender) },
    { role: "system", content: `CURRENT STATE (authoritative, rebuilt this turn):\n${renderState(input.state, input.draft)}` },
    ...history,
    { role: "user", content: userContent },
  ];

  const toolCalls: { name: string; args: unknown }[] = [];
  let finalText = "";
  let toolsRan = false;
  let retriedClaim = false;
  let retriedSaved = false;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const completion = await createCompletion(messages);
    const msg = completion.choices[0]?.message;
    if (!msg) break;
    const calls = msg.tool_calls?.filter((c) => c.type === "function") ?? [];
    if (calls.length === 0) {
      const text = msg.content ?? "";
      // A reply that says it logged/changed something when no tool ran this turn is a hallucinated action — nothing actually happened. Make the model do it for real.
      if (!toolsRan && !retriedClaim && CLAIMS_ACTION.test(text)) {
        retriedClaim = true;
        messages.push(msg);
        messages.push({
          role: "system",
          content: "Your reply claims you logged/changed/recorded something, but you called NO tool this turn, so nothing was actually done. Call the right tool(s) now (log_food, log_workout, update_draft, manage_reminders…), then answer using their real results. If no action was actually needed, answer again without claiming an action.",
        });
        continue;
      }
      if (!retriedSaved && CLAIMS_SAVED.test(text) && !isDraftEmpty(ctx.draft)) {
        retriedSaved = true;
        messages.push(msg);
        messages.push({
          role: "system",
          content: "Your reply says something was SAVED, but you can't save anything — the draft is still waiting for the user's confirmation (👍 / \"כן\"). Answer again without claiming it was saved: say it's ready/waiting and that a 👍 or \"כן\" will save it.",
        });
        continue;
      }
      finalText = text;
      break;
    }
    toolsRan = true;
    messages.push(msg);
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        // malformed arguments → handled below as an empty-args error result
      }
      toolCalls.push({ name: call.function.name, args });
      const tool = TOOL_BY_NAME.get(call.function.name);
      let result: unknown;
      try {
        try {
          result = tool ? await tool.run(args, ctx) : { error: `Unknown tool ${call.function.name}` };
        } catch (first) {
          // Tools lean on OpenAI/search calls that fail transiently (rate limits, blips) — seen live as "הייתה תקלה" three messages in a row. One quiet retry before admitting defeat.
          console.error(`[agent] tool ${call.function.name} failed, retrying once:`, first);
          await sleep(2000);
          result = await tool!.run(args, ctx);
        }
      } catch (err) {
        console.error(`[agent] tool ${call.function.name} failed:`, err);
        result = { error: `Tool failed: ${err instanceof Error ? err.message : String(err)}. Tell the user honestly it didn't work and offer to try again.` };
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
    // The draft changed under the model's feet — keep its picture of it current for the next round.
    messages.push({ role: "system", content: `DRAFT NOW:\n${renderDraft(ctx.draft).join("\n") || "(empty)"}` });
  }

  if (!finalText.trim()) {
    const fallback = await getOpenAIClient().chat.completions.create({ model: AGENT_MODEL, temperature: 0.4, messages });
    finalText = fallback.choices[0]?.message?.content ?? "";
  }
  const replyContent = ensureNumbersShown(stripMarkdown(finalText), ctx.draft, input.lang);
  return { replyContent, draft: ctx.draft, mistakeFlagged: !!ctx.mistakeFlagged, toolCalls };
}

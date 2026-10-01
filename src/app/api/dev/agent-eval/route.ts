/**
 * Dev-only harness for the chat agent's regression suite (scripts/agent-evals).
 * Runs the real agent against an in-memory conversation + optional state
 * overrides, with all writes stubbed (dryRun). Hard-disabled in production.
 */
import { NextResponse } from "next/server";
import { runAgent } from "@/lib/agent/agent";
import { buildAgentState, type AgentState, type Draft } from "@/lib/agent/state";
import type { ChatMessage } from "@/lib/types";

export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production" || req.headers.get("x-eval-secret") !== "local-eval") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const body = (await req.json()) as {
    uid: string;
    today: string;
    nowIso: string;
    lang?: "en" | "he";
    userMessage: string;
    imageUrls?: string[];
    priorMessages: ChatMessage[];
    draft?: Draft;
    stateOverride?: Partial<AgentState>;
  };
  const base = await buildAgentState(body.uid, body.today, body.nowIso);
  const state = { ...base, ...body.stateOverride };
  const out = await runAgent({
    uid: body.uid,
    lang: body.lang ?? "he",
    today: body.today,
    userMessage: body.userMessage,
    imageUrls: body.imageUrls,
    priorMessages: body.priorMessages,
    state,
    draft: body.draft ?? {},
    dryRun: true,
  });
  return NextResponse.json(out);
}

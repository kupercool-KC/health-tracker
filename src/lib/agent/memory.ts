/**
 * Long-term memory for the chat agent: short durable facts about the user
 * ("השייק הרגיל שלי = 128 קלוריות / 26 חלבון", "לא אוכלת בשר") that the agent
 * saves itself via the `remember` tool and reads back at the start of every
 * turn — so it stops re-learning the same thing every conversation.
 * Stored at users/{uid}/meta/agentMemory.
 */
import "server-only";
import { adminDb } from "@/lib/firebase/admin";

export interface AgentFact {
  id: string;
  text: string;
  createdAt: string;
}

const MAX_FACTS = 40;

function ref(uid: string) {
  return adminDb.collection("users").doc(uid).collection("meta").doc("agentMemory");
}

export async function readFacts(uid: string): Promise<AgentFact[]> {
  const data = (await ref(uid).get()).data() as { facts?: AgentFact[] } | undefined;
  return data?.facts ?? [];
}

export async function addFact(uid: string, text: string): Promise<AgentFact> {
  const facts = await readFacts(uid);
  const fact: AgentFact = { id: crypto.randomUUID().slice(0, 8), text: text.trim(), createdAt: new Date().toISOString() };
  const next = [...facts.filter((f) => f.text.trim() !== fact.text), fact].slice(-MAX_FACTS);
  await ref(uid).set({ facts: next }, { merge: true });
  return fact;
}

export async function removeFact(uid: string, idOrText: string): Promise<AgentFact | null> {
  const facts = await readFacts(uid);
  const needle = idOrText.trim().toLowerCase();
  const target = facts.find((f) => f.id === idOrText.trim()) ?? facts.find((f) => f.text.toLowerCase().includes(needle));
  if (!target) return null;
  await ref(uid).set({ facts: facts.filter((f) => f.id !== target.id) }, { merge: true });
  return target;
}

/** Complaints ("you're wrong") are logged so recurring failure patterns can be reviewed later instead of vanishing into chat history. */
export async function logMistake(
  uid: string,
  entry: { userMessage: string; lastAssistantMessage?: string; note: string },
): Promise<void> {
  await adminDb
    .collection("users")
    .doc(uid)
    .collection("agentFeedback")
    .add({ ...entry, createdAt: new Date().toISOString() });
}

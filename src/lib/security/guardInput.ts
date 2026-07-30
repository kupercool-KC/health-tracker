/**
 * Shared wrapper around the chat's prompt-injection guard (src/lib/chat/security.ts)
 * for the *other* free-text entry points that reach an LLM — meal/workout
 * logging text boxes and onboarding's "other" category boxes. Chat has its
 * own inline wiring in src/app/api/chat/route.ts (it already had the
 * uid/email/session plumbing in place); this covers everywhere else so a
 * jailbreak attempt isn't only caught when typed into the chat panel.
 */
import "server-only";
import { checkPromptSafety, securityReply } from "@/lib/chat/security";
import { sendSecurityAlert } from "@/lib/security/alertEmail";

export interface GuardResult {
  flagged: boolean;
  message?: string;
}

export async function guardFreeText(params: {
  uid: string;
  email?: string;
  lang: "en" | "he";
  text: string;
  /** Short tag identifying which entry point this came from, e.g. "meal", "workout", "onboarding-other-diet". */
  context: string;
}): Promise<GuardResult> {
  const safety = await checkPromptSafety(params.text);
  if (!safety.flagged) return { flagged: false };

  const message = securityReply(params.lang);
  await sendSecurityAlert({
    uid: params.uid,
    email: params.email,
    question: `[${params.context}] ${params.text}`,
    answer: message,
    reason: safety.reason,
    createdAt: new Date().toISOString(),
  });
  return { flagged: true, message };
}

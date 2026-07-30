/**
 * Sends an email alert when the chat's prompt-injection guard (see
 * src/lib/chat/security.ts) flags a message. Configured via SMTP env vars —
 * if they're not set, this logs a warning and no-ops rather than throwing,
 * so a missing mail config never breaks the chat response itself.
 */
import "server-only";
import nodemailer from "nodemailer";

export interface SecurityAlertDetails {
  uid: string;
  email?: string;
  sessionId?: string;
  question: string;
  answer: string;
  reason?: string;
  createdAt: string;
}

function getTransport() {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !port || !user || !pass) return null;
  return nodemailer.createTransport({
    host,
    port: Number(port),
    secure: Number(port) === 465,
    auth: { user, pass },
  });
}

export async function sendSecurityAlert(details: SecurityAlertDetails): Promise<void> {
  const to = process.env.SECURITY_ALERT_EMAIL_TO;
  const transport = getTransport();
  if (!to || !transport) {
    console.warn("[security] Prompt-injection attempt flagged but SMTP/alert env vars are not configured — skipping email.", details);
    return;
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  try {
    await transport.sendMail({
      from,
      to,
      subject: "Health Tracker: suspicious chat input flagged",
      text: [
        `Time: ${details.createdAt}`,
        `User: ${details.email ?? "(no email)"} (uid: ${details.uid})`,
        `Session: ${details.sessionId ?? "(new session)"}`,
        details.reason ? `Reason: ${details.reason}` : null,
        "",
        "Question:",
        details.question,
        "",
        "Answer given to user:",
        details.answer,
      ]
        .filter(Boolean)
        .join("\n"),
    });
  } catch (err) {
    // Never let an alert-delivery failure surface to the chat user.
    console.error("[security] Failed to send prompt-injection alert email:", err);
  }
}

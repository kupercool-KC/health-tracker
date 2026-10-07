/**
 * Who may use the paid parts of the product (the chat agent, on web and WhatsApp).
 *
 * One record per user — users/{uid}/billing/status — written ONLY by the
 * server (the RevenueCat webhook below, or by hand in the Firebase console);
 * clients can read it but firestore.rules blocks client writes. RevenueCat is
 * the single source of truth for payments: Apple in-app purchases and web
 * checkout (Stripe) both land there and are mirrored here through its webhook,
 * so the rest of the app only ever asks "is this uid entitled?".
 *
 * Enforcement is OFF until appConfig/billing.enforce = true, so nothing
 * changes for existing users until the switch is flipped. Once it is, anyone
 * without a status doc gets a free trial starting at that moment.
 */
import "server-only";
import { adminDb } from "@/lib/firebase/admin";

export const TRIAL_DAYS = 14;

export type BillingSource = "apple" | "stripe" | "google" | "manual" | "trial";
export type BillingStatusValue = "trial" | "active" | "grace" | "expired" | "cancelled";

export interface BillingStatus {
  status: BillingStatusValue;
  source: BillingSource;
  plan?: string;
  trialEndsAt?: string;
  /** When paid access ends (subscription period end). */
  expiresAt?: string;
  updatedAt: string;
}

export interface Entitlement {
  /** May use the paid features right now. */
  active: boolean;
  status: BillingStatusValue | "unenforced";
  daysLeftInTrial?: number;
}

let cachedEnforce: { at: number; enforce: boolean } | null = null;

async function isEnforced(): Promise<boolean> {
  if (cachedEnforce && Date.now() - cachedEnforce.at < 60_000) return cachedEnforce.enforce;
  let enforce = false;
  try {
    const data = (await adminDb.collection("appConfig").doc("billing").get()).data() as { enforce?: boolean } | undefined;
    enforce = data?.enforce === true;
  } catch {
    // a config read failure must never lock users out — default to not enforcing
  }
  cachedEnforce = { at: Date.now(), enforce };
  return enforce;
}

const statusRef = (uid: string) => adminDb.collection("users").doc(uid).collection("billing").doc("status");

export async function getEntitlement(uid: string): Promise<Entitlement> {
  if (!(await isEnforced())) return { active: true, status: "unenforced" };

  const ref = statusRef(uid);
  let current = (await ref.get()).data() as BillingStatus | undefined;
  if (!current) {
    const now = new Date();
    current = {
      status: "trial",
      source: "trial",
      trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * 86_400_000).toISOString(),
      updatedAt: now.toISOString(),
    };
    await ref.set(current);
  }

  const now = Date.now();
  if (current.status === "trial") {
    const left = Math.ceil((Date.parse(current.trialEndsAt ?? "") - now) / 86_400_000);
    return left > 0 ? { active: true, status: "trial", daysLeftInTrial: left } : { active: false, status: "expired" };
  }
  if (current.status === "active" || current.status === "grace" || current.status === "cancelled") {
    // "cancelled" = auto-renew turned off but the paid period hasn't ended yet.
    const paidUntil = current.expiresAt ? Date.parse(current.expiresAt) : Infinity;
    return paidUntil > now ? { active: true, status: current.status } : { active: false, status: "expired" };
  }
  return { active: false, status: "expired" };
}

export async function writeBillingStatus(uid: string, patch: Partial<BillingStatus>): Promise<void> {
  await statusRef(uid).set({ ...patch, updatedAt: new Date().toISOString() }, { merge: true });
}

const PAYWALL = {
  he: (url: string) =>
    `תקופת הניסיון שלך הסתיימה 🙏 כדי להמשיך לדבר איתי ולעקוב אחרי היום שלך, אפשר להצטרף כאן:\n${url}\nהנתונים שלך שמורים ומחכים לך.`,
  en: (url: string) =>
    `Your free trial has ended 🙏 To keep chatting with me and tracking your day, you can subscribe here:\n${url}\nYour data is safe and waiting for you.`,
} as const;

export function paywallMessage(lang: "en" | "he"): string {
  return PAYWALL[lang](process.env.BILLING_PAY_URL ?? "https://health-tracker-sepia.vercel.app/profile");
}

/**
 * POST /api/billing/revenuecat — RevenueCat webhook (Apple + web purchases).
 * Auth: `Authorization: Bearer ${REVENUECAT_WEBHOOK_AUTH}` (set the same value
 * in RevenueCat → Project → Integrations → Webhooks). RevenueCat's
 * `app_user_id` must be the Firebase uid (the app logs in to RevenueCat with it).
 */
import { NextResponse } from "next/server";
import { writeBillingStatus, type BillingSource } from "@/lib/billing/entitlement";

interface RevenueCatEvent {
  type?: string;
  app_user_id?: string;
  product_id?: string;
  store?: string;
  expiration_at_ms?: number | null;
}

const SOURCE_BY_STORE: Record<string, BillingSource> = { APP_STORE: "apple", MAC_APP_STORE: "apple", PLAY_STORE: "google", STRIPE: "stripe", RC_BILLING: "stripe" };

export async function POST(req: Request) {
  const secret = process.env.REVENUECAT_WEBHOOK_AUTH;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const event = ((await req.json().catch(() => null)) as { event?: RevenueCatEvent } | null)?.event;
  const uid = event?.app_user_id;
  if (!event?.type || !uid || uid.startsWith("$RCAnonymousID")) return NextResponse.json({ ok: true, ignored: true });

  const base = {
    source: SOURCE_BY_STORE[event.store ?? ""] ?? ("apple" as BillingSource),
    plan: event.product_id,
    ...(event.expiration_at_ms ? { expiresAt: new Date(event.expiration_at_ms).toISOString() } : {}),
  };

  switch (event.type) {
    case "INITIAL_PURCHASE":
    case "RENEWAL":
    case "UNCANCELLATION":
    case "PRODUCT_CHANGE":
    case "NON_RENEWING_PURCHASE":
      await writeBillingStatus(uid, { ...base, status: "active" });
      break;
    case "CANCELLATION": // auto-renew off; access continues until expiresAt
      await writeBillingStatus(uid, { ...base, status: "cancelled" });
      break;
    case "BILLING_ISSUE":
      await writeBillingStatus(uid, { ...base, status: "grace" });
      break;
    case "EXPIRATION":
      await writeBillingStatus(uid, { ...base, status: "expired" });
      break;
    default:
      break; // TEST, TRANSFER, etc.
  }
  return NextResponse.json({ ok: true });
}

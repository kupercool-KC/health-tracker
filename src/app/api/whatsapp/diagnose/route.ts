/**
 * TEMPORARY debug endpoint — not part of the app's real surface, delete once
 * the WhatsApp webhook is confirmed working end to end.
 *
 * GET  ?token=<WHATSAPP_VERIFY_TOKEN>            — lists which apps are subscribed to the WABA's webhook events
 * POST ?token=<WHATSAPP_VERIFY_TOKEN>             — subscribes this app to the WABA's webhook events (the step that's
 *                                                    easy to miss: verifying the Callback URL at the app level does NOT
 *                                                    by itself make a specific WhatsApp Business Account forward its
 *                                                    events there — POST /{waba-id}/subscribed_apps does)
 *
 * Gated behind the same WHATSAPP_VERIFY_TOKEN secret already set up for the
 * real webhook, rather than a new env var, since this is throwaway.
 */
import { NextResponse } from "next/server";

const WABA_ID = "1098921406195477";
const GRAPH_VERSION = "v21.0";

function authorized(req: Request): boolean {
  const token = new URL(req.url).searchParams.get("token");
  return !!token && token === process.env.WHATSAPP_VERIFY_TOKEN;
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${WABA_ID}/subscribed_apps`, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
  });
  return NextResponse.json(await res.json(), { status: res.status });
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${WABA_ID}/subscribed_apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
  });
  return NextResponse.json(await res.json(), { status: res.status });
}

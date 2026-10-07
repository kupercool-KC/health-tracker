/**
 * POST /api/account/delete
 * Body: { confirm: "DELETE" }
 * Auth: Firebase ID token (Bearer).
 *
 * Irreversibly deletes the signed-in user's account and all their data.
 * An active App Store / web subscription is NOT cancelled by this — the
 * Profile screen tells the user to cancel it in their Apple/Stripe settings.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getUidFromRequest } from "@/lib/auth";
import { deleteAccount } from "@/lib/account/deleteAccount";

const bodySchema = z.object({ confirm: z.literal("DELETE") });

export async function POST(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!bodySchema.safeParse(await req.json().catch(() => null)).success) {
    return NextResponse.json({ error: 'Send { "confirm": "DELETE" }' }, { status: 400 });
  }
  await deleteAccount(uid);
  return NextResponse.json({ ok: true });
}

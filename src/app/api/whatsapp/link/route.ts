/**
 * POST /api/whatsapp/link
 * Body: { phone: string }
 * DELETE /api/whatsapp/link
 * Body: { phone: string }
 * Auth: Firebase ID token (Bearer) on both.
 *
 * Links/unlinks the signed-in user's WhatsApp number for the bot — see
 * src/lib/whatsapp/link.ts for the two records this keeps in sync.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getUidFromRequest } from "@/lib/auth";
import { linkPhoneToUid, normalizePhone, unlinkPhone } from "@/lib/whatsapp/link";

const bodySchema = z.object({ phone: z.string().min(6) });

export async function POST(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsedBody = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Invalid request", details: parsedBody.error.flatten() }, { status: 400 });
  }

  const phone = normalizePhone(parsedBody.data.phone);
  if (phone.length < 8) {
    return NextResponse.json({ error: "Invalid phone number" }, { status: 400 });
  }

  const result = await linkPhoneToUid(uid, phone);
  if (!result.ok) {
    return NextResponse.json({ error: "This number is already linked to another account" }, { status: 409 });
  }
  return NextResponse.json({ ok: true, phone });
}

export async function DELETE(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsedBody = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Invalid request", details: parsedBody.error.flatten() }, { status: 400 });
  }

  await unlinkPhone(uid, normalizePhone(parsedBody.data.phone));
  return NextResponse.json({ ok: true });
}

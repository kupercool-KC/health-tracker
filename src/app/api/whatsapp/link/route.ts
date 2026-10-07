/**
 * POST /api/whatsapp/link   (no body) → { code, expiresInMin, botNumber }: a one-time code the user
 *   sends to the bot from their own WhatsApp to prove the number is theirs and link it.
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
import { normalizePhone, unlinkPhone } from "@/lib/whatsapp/link";
import { createLinkCode, getBotNumber } from "@/lib/whatsapp/linkCode";

const bodySchema = z.object({ phone: z.string().min(6) });

export async function POST(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // No phone in the body anymore: the number is proven by sending the code from it (see linkCode.ts).
  const { code, expiresInMin } = await createLinkCode(uid);
  return NextResponse.json({ ok: true, code, expiresInMin, botNumber: await getBotNumber() });
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

/**
 * POST   /api/settings/health-token  — mint a new personal Health Sync token
 *                                       (revokes any previous one), returned
 *                                       once as plaintext.
 * DELETE /api/settings/health-token  — revoke the current token.
 * Auth: Firebase ID token (Bearer) — same as the rest of the app's own UI.
 */
import { NextResponse } from "next/server";
import { getUidFromRequest } from "@/lib/auth";
import { createHealthToken, revokeHealthToken } from "@/lib/healthToken";

export async function POST(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const token = await createHealthToken(uid);
  return NextResponse.json({ token }, { status: 201 });
}

export async function DELETE(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await revokeHealthToken(uid);
  return NextResponse.json({ revoked: true }, { status: 200 });
}

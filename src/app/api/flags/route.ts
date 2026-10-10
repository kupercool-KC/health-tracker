/** GET /api/flags — which feature flags are on for the signed-in user. Auth: Firebase ID token. */
import { NextResponse } from "next/server";
import { getUidFromRequest } from "@/lib/auth";
import { flagsFor } from "@/lib/flags/server";

export async function GET(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ flags: await flagsFor(uid) });
}

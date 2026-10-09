/**
 * POST /api/app/version
 * Body: { version: string, build: string, platform: "ios" | "android" }
 * Auth: Firebase ID token (Bearer).
 *
 * The native app reports which build it is running each time it opens, so we can tell from Firestore
 * (appBuilds/{version}-{build}) when a new TestFlight/App Store build is actually live and who is on it,
 * without asking the person who uploads it. Only the app version, build number and platform are stored.
 */
import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { getUidFromRequest } from "@/lib/auth";
import { adminDb } from "@/lib/firebase/admin";

const bodySchema = z.object({
  version: z.string().min(1).max(32),
  build: z.string().min(1).max(32),
  platform: z.enum(["ios", "android"]),
});

export async function POST(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { version, build, platform } = parsed.data;

  const now = new Date().toISOString();
  const key = `${platform}-${version}-${build}`.replace(/[^\w.-]/g, "_");
  const ref = adminDb.collection("appBuilds").doc(key);
  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      tx.set(ref, { platform, version, build, firstSeenAt: now, lastSeenAt: now, opens: 1, uids: [uid] });
    } else {
      tx.update(ref, { lastSeenAt: now, opens: FieldValue.increment(1), uids: FieldValue.arrayUnion(uid) });
    }
  });
  await adminDb.collection("users").doc(uid).collection("meta").doc("client").set({ platform, version, build, lastSeenAt: now });
  return NextResponse.json({ ok: true });
}

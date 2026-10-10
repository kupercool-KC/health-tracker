/**
 * POST /api/metrics/refresh — recomputes (or returns the cached) metrics for the signed-in user.
 * The Progress screen calls it on open so it is correct even before the nightly job has run.
 * Auth: Firebase ID token (Bearer). Metrics younger than 20 minutes are returned as cached.
 */
import { NextResponse } from "next/server";
import { getUidFromRequest } from "@/lib/auth";
import { adminDb } from "@/lib/firebase/admin";
import { computeMetrics } from "@/lib/metrics/compute";
import type { MetricsCurrent } from "@/lib/types";

export async function POST(req: Request) {
  const uid = await getUidFromRequest(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ref = adminDb.collection("users").doc(uid).collection("metrics").doc("current");
  const cached = (await ref.get()).data() as MetricsCurrent | undefined;
  if (cached && Date.now() - Date.parse(cached.computedAt) < 20 * 60 * 1000) return NextResponse.json({ metrics: cached });
  const metrics = await computeMetrics(uid);
  return NextResponse.json({ metrics });
}

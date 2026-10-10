/**
 * GET /api/cron/nightly
 * Auth: `Authorization: Bearer ${CRON_SECRET}`. Pinged once a night by cron-job.org (same pattern as the
 * WhatsApp reminders): recomputes metrics for every onboarded user. Insight generation is chained here too
 * (see src/lib/insights/generate.ts) once it exists.
 */
import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { computeMetrics } from "@/lib/metrics/compute";

export const maxDuration = 300;

export async function GET(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const refs = await adminDb.collection("users").listDocuments();
  let computed = 0;
  let failed = 0;
  for (const ref of refs) {
    try {
      if (await computeMetrics(ref.id)) computed++;
    } catch (err) {
      failed++;
      console.error("[nightly] metrics failed for", ref.id, err);
    }
  }
  return NextResponse.json({ users: refs.length, computed, failed });
}

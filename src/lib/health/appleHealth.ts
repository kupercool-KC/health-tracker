/**
 * Apple Health (HealthKit) sync — native iOS app only.
 *
 * Reads daily step totals and the latest weigh-in from HealthKit and posts them to the same
 * endpoints the chat uses (/api/steps, /api/body-metrics). Read-only: nothing is written back
 * to Health. Per Apple's HealthKit rules the data is used only for the user's own tracking.
 * The "enabled" flag lives in localStorage because HealthKit permission is per device.
 */
import { Capacitor } from "@capacitor/core";
import { Health } from "@capgo/capacitor-health";
import { auth } from "@/lib/firebase/client";
import { localDateKey } from "@/lib/dashboard/queries";

const ENABLED_KEY = "appleHealth:enabled";
const SIGNATURE_KEY = "appleHealth:lastWeight";
const STEP_DAYS = 3;

export function isAppleHealthSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}

export function isAppleHealthEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAppleHealthEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(ENABLED_KEY, "1");
    else localStorage.removeItem(ENABLED_KEY);
  } catch {
    /* storage unavailable — flag just won't persist */
  }
}

/** Asks iOS for read access. Returns false if HealthKit is unavailable here (e.g. iPad without Health). */
export async function connectAppleHealth(): Promise<boolean> {
  if (!isAppleHealthSupported()) return false;
  const { available } = await Health.isAvailable();
  if (!available) return false;
  await Health.requestAuthorization({ read: ["steps", "weight"] });
  setAppleHealthEnabled(true);
  return true;
}

async function post(path: string, body: unknown): Promise<void> {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error("Not signed in");
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
}

/** Pushes the last few days of steps and the newest weight. Safe to call often. */
export async function syncAppleHealth(): Promise<{ stepDays: number; weight: boolean }> {
  if (!isAppleHealthSupported() || !isAppleHealthEnabled() || !auth.currentUser) {
    return { stepDays: 0, weight: false };
  }

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (STEP_DAYS - 1));

  let stepDays = 0;
  const { samples } = await Health.queryAggregated({
    dataType: "steps",
    startDate: start.toISOString(),
    endDate: new Date().toISOString(),
    bucket: "day",
    aggregation: "sum",
  });
  for (const s of samples) {
    const steps = Math.round(s.value);
    if (steps <= 0) continue;
    await post("/api/steps", { steps, date: localDateKey(new Date(s.startDate)) });
    stepDays++;
  }

  let weight = false;
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const { samples: weights } = await Health.readSamples({
    dataType: "weight",
    startDate: weekAgo.toISOString(),
    endDate: new Date().toISOString(),
    limit: 1,
    ascending: false,
  });
  const latest = weights[0];
  if (latest && latest.value > 0) {
    const date = localDateKey(new Date(latest.startDate));
    const kg = Math.round(latest.value * 10) / 10;
    const signature = `${date}:${kg}`;
    let last: string | null = null;
    try {
      last = localStorage.getItem(SIGNATURE_KEY);
    } catch {
      /* ignore */
    }
    if (last !== signature) {
      await post("/api/body-metrics", { parsed: { weightKg: kg }, date });
      try {
        localStorage.setItem(SIGNATURE_KEY, signature);
      } catch {
        /* ignore */
      }
      weight = true;
    }
  }
  return { stepDays, weight };
}

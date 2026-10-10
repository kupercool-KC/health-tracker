/**
 * Apple Health (HealthKit) sync — native iOS app only.
 *
 * Reads workouts, daily steps, weight, body fat, height, sleep and resting heart rate from HealthKit and posts
 * them to /api/health/import (which dedupes by HealthKit id, merges duplicate manual workouts and derives
 * profile suggestions). Read-only: nothing is ever written back to Health. The "enabled" flag lives in
 * localStorage because HealthKit permission is per device.
 */
import { Capacitor } from "@capacitor/core";
import { Health, type HealthSample } from "@capgo/capacitor-health";
import { auth } from "@/lib/firebase/client";
import { localDateKey } from "@/lib/dashboard/queries";
import type { HealthSuggestions } from "@/lib/health/suggestions";

const ENABLED_KEY = "appleHealth:enabled";
const LAST_FULL_KEY = "appleHealth:lastFull";
export const INITIAL_IMPORT_DAYS = 60;
const INCREMENTAL_DAYS = 3;
const WEEK_MS = 7 * 24 * 3600 * 1000;

export function isAppleHealthSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}

function readFlag(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeFlag(key: string, value: string | null) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — flag just won't persist */
  }
}

export function isAppleHealthEnabled(): boolean {
  return readFlag(ENABLED_KEY) === "1";
}

export function setAppleHealthEnabled(on: boolean): void {
  writeFlag(ENABLED_KEY, on ? "1" : null);
}

/** Asks iOS for read access. Returns false if HealthKit is unavailable here (e.g. iPad without Health). The sheet is shown only once per install. */
export async function connectAppleHealth(): Promise<boolean> {
  if (!isAppleHealthSupported()) return false;
  const { available } = await Health.isAvailable();
  if (!available) return false;
  await Health.requestAuthorization({ read: ["steps", "weight", "workouts", "sleep", "restingHeartRate", "height", "bodyFat"] });
  setAppleHealthEnabled(true);
  return true;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error("Not signed in");
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return (await res.json()) as T;
}

/** Local yyyy-mm-dd of an ISO timestamp. */
const dayOf = (iso: string) => localDateKey(new Date(iso));

/** Group sleep samples into nights keyed by the day the night ENDS on. */
function sleepNights(samples: HealthSample[]): { date: string; asleepMin: number; inBedMin?: number }[] {
  const nights = new Map<string, { asleepMin: number; inBedMin: number }>();
  for (const s of samples) {
    // A sleep segment that ends before 18:00 belongs to the night ending that day; later ones to the next day's night.
    const end = new Date(s.endDate);
    const key = localDateKey(end.getHours() >= 18 ? new Date(end.getTime() + 24 * 3600 * 1000) : end);
    const minutes = Math.max(0, (end.getTime() - new Date(s.startDate).getTime()) / 60000);
    const cur = nights.get(key) ?? { asleepMin: 0, inBedMin: 0 };
    if (s.sleepState === "inBed") cur.inBedMin += minutes;
    else if (s.sleepState && s.sleepState !== "awake") cur.asleepMin += minutes;
    nights.set(key, cur);
  }
  return [...nights.entries()]
    .map(([date, v]) => ({ date, asleepMin: v.asleepMin, inBedMin: v.inBedMin || undefined }))
    .filter((n) => n.asleepMin > 0);
}

export interface ImportResult {
  merged: number;
  suggestions: HealthSuggestions;
}

/** Reads `days` of data from HealthKit and sends it to the server. `autoFill` also updates the profile from it. */
export async function importAppleHealth(days: number, opts: { autoFill?: boolean } = {}): Promise<ImportResult> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const range = { startDate: start.toISOString(), endDate: new Date().toISOString() };

  const [workoutsRes, stepsRes, sleepRes, hrRes, weightRes, fatRes, heightRes] = await Promise.all([
    Health.queryWorkouts({ ...range, limit: 1000 }).catch(() => ({ workouts: [] })),
    Health.queryAggregated({ dataType: "steps", ...range, bucket: "day", aggregation: "sum" }).catch(() => ({ samples: [] })),
    Health.readSamples({ dataType: "sleep", ...range, limit: 5000 }).catch(() => ({ samples: [] })),
    Health.queryAggregated({ dataType: "restingHeartRate", ...range, bucket: "day", aggregation: "average" }).catch(() => ({ samples: [] })),
    Health.readSamples({ dataType: "weight", ...range, limit: 400 }).catch(() => ({ samples: [] })),
    Health.readSamples({ dataType: "bodyFat", ...range, limit: 400 }).catch(() => ({ samples: [] })),
    Health.readSamples({ dataType: "height", startDate: new Date(Date.now() - 3650 * 24 * 3600 * 1000).toISOString(), endDate: range.endDate, limit: 1 }).catch(() => ({ samples: [] })),
  ]);

  const workouts = workoutsRes.workouts.map((w) => ({
    externalId: w.platformId ?? `${w.workoutType}-${w.startDate}`,
    hkType: w.workoutType as string,
    startTime: new Date(w.startDate).toISOString(),
    endTime: new Date(w.endDate).toISOString(),
    durationSec: Math.round(w.duration),
    date: dayOf(w.startDate),
    calories: w.totalEnergyBurned,
    distanceM: w.totalDistance,
    device: /watch/i.test(w.sourceName ?? "") ? "watch" : w.sourceName ? "phone" : undefined,
  }));

  const steps = stepsRes.samples.filter((s) => s.value > 0).map((s) => ({ date: dayOf(s.startDate), steps: Math.round(s.value) }));
  const sleep = sleepNights(sleepRes.samples);
  const restingHr = hrRes.samples.filter((s) => s.value > 0).map((s) => ({ date: dayOf(s.startDate), bpm: s.value }));

  // Body: one entry per day from weight and body-fat samples (HealthKit reports body fat as a fraction 0..1 or a percent).
  const body = new Map<string, { date: string; weightKg?: number; bodyFatPercent?: number }>();
  for (const s of weightRes.samples) {
    const date = dayOf(s.startDate);
    body.set(date, { ...(body.get(date) ?? { date }), weightKg: s.value });
  }
  for (const s of fatRes.samples) {
    const date = dayOf(s.startDate);
    body.set(date, { ...(body.get(date) ?? { date }), bodyFatPercent: s.value <= 1 ? s.value * 100 : s.value });
  }
  const heightSample = heightRes.samples[0];
  const heightCm = heightSample ? (heightSample.unit === "meter" ? heightSample.value * 100 : heightSample.value) : undefined;

  const result = await post<{ merged: number; suggestions: HealthSuggestions }>("/api/health/import", {
    workouts,
    steps,
    sleep,
    restingHr,
    body: [...body.values()],
    heightCm: heightCm && heightCm > 50 && heightCm < 250 ? Math.round(heightCm) : undefined,
    spanDays: days,
    autoFill: opts.autoFill,
  });
  if (days >= INITIAL_IMPORT_DAYS) writeFlag(LAST_FULL_KEY, String(Date.now()));
  // Screens (Today) listen for this to reload their numbers.
  window.dispatchEvent(new Event("health:synced"));
  return result;
}

/** Called on every app open: re-reads the last few days; once a week does a full 60-day pass that also refreshes the profile. */
let lastSyncAt = 0;
let syncing: Promise<ImportResult | null> | null = null;

export async function syncAppleHealth(opts: { force?: boolean } = {}): Promise<ImportResult | null> {
  if (!isAppleHealthSupported() || !isAppleHealthEnabled() || !auth.currentUser) return null;
  // Throttle automatic syncs to once a minute; a pull-to-refresh forces one. Overlapping calls share the same run.
  if (syncing) return syncing;
  if (!opts.force && Date.now() - lastSyncAt < 60_000) return null;
  syncing = runSync().finally(() => {
    syncing = null;
  });
  return syncing;
}

async function runSync(): Promise<ImportResult | null> {
  const lastFull = Number(readFlag(LAST_FULL_KEY) ?? 0);
  const full = Date.now() - lastFull > WEEK_MS;
  const result = await importAppleHealth(full ? INITIAL_IMPORT_DAYS : INCREMENTAL_DAYS, { autoFill: full });
  lastSyncAt = Date.now();
  return result;
}

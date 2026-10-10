import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { MAX_WATER_ENTRY_ML } from "./water";
import type { WaterDay } from "@/lib/types";

const ref = (uid: string, date: string) => adminDb.collection("users").doc(uid).collection("water").doc(date);

/** Adds `ml` (can be negative via undoLastWater instead) to the day's total. Returns the new total. */
export async function addWater(uid: string, date: string, ml: number): Promise<WaterDay> {
  const amount = Math.round(ml);
  if (!(amount > 0 && amount <= MAX_WATER_ENTRY_ML)) throw new Error("Invalid amount");
  const now = new Date().toISOString();
  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref(uid, date));
    const cur = snap.data() as WaterDay | undefined;
    const day: WaterDay = { date, ml: (cur?.ml ?? 0) + amount, entries: [...(cur?.entries ?? []), { time: now, ml: amount }], updatedAt: now };
    tx.set(ref(uid, date), day);
    return day;
  });
}

export async function undoLastWater(uid: string, date: string): Promise<WaterDay | null> {
  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref(uid, date));
    const cur = snap.data() as WaterDay | undefined;
    if (!cur || cur.entries.length === 0) return null;
    const entries = cur.entries.slice(0, -1);
    const day: WaterDay = { date, ml: entries.reduce((s, e) => s + e.ml, 0), entries, updatedAt: new Date().toISOString() };
    tx.set(ref(uid, date), day);
    return day;
  });
}

export async function getWater(uid: string, date: string): Promise<WaterDay | null> {
  return ((await ref(uid, date).get()).data() as WaterDay | undefined) ?? null;
}

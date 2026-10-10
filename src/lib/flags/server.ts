import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { resolveAllFlags, resolveFlag, type FlagConfig, type FlagKey } from "./flags";

let cache: { at: number; config: FlagConfig | undefined } | null = null;

async function config(): Promise<FlagConfig | undefined> {
  if (cache && Date.now() - cache.at < 30_000) return cache.config;
  let value: FlagConfig | undefined;
  try {
    value = (await adminDb.collection("appConfig").doc("flags").get()).data() as FlagConfig | undefined;
  } catch {
    value = undefined; // on a read failure fall back to the code defaults
  }
  cache = { at: Date.now(), config: value };
  return value;
}

export async function flagOn(uid: string | null | undefined, key: FlagKey): Promise<boolean> {
  return resolveFlag(await config(), uid, key);
}

export async function flagsFor(uid: string | null | undefined) {
  return resolveAllFlags(await config(), uid);
}

/**
 * Feature flags (shared types + rules). A new feature ships to `main` behind a flag so Iddo can try it in the real
 * app before anyone else sees it:
 *   "off"     — nobody
 *   "preview" — only the preview users (the admin by default; more uids can be listed in appConfig/flags.previewUids)
 *   "on"      — everybody
 * Defaults live here; appConfig/flags in Firestore overrides them without a deploy (flipping to "on" is the approval).
 */
import { ADMIN_UID } from "@/lib/admin";

export type FlagKey = "water";
export type FlagState = "off" | "preview" | "on";

/** State of each flag until appConfig/flags says otherwise. New features start in "preview". */
export const DEFAULT_FLAGS: Record<FlagKey, FlagState> = {
  water: "preview",
};

export interface FlagConfig {
  flags?: Partial<Record<FlagKey, FlagState>>;
  previewUids?: string[];
}

export function resolveFlag(config: FlagConfig | undefined, uid: string | null | undefined, key: FlagKey): boolean {
  const state = config?.flags?.[key] ?? DEFAULT_FLAGS[key];
  if (state === "on") return true;
  if (state === "off" || !uid) return false;
  return uid === ADMIN_UID || (config?.previewUids ?? []).includes(uid);
}

export function resolveAllFlags(config: FlagConfig | undefined, uid: string | null | undefined): Record<FlagKey, boolean> {
  return Object.fromEntries((Object.keys(DEFAULT_FLAGS) as FlagKey[]).map((k) => [k, resolveFlag(config, uid, k)])) as Record<FlagKey, boolean>;
}

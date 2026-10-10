"use client";

import { useEffect, useState } from "react";
import { auth } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/useAuth";
import type { FlagKey } from "./flags";

let cached: { uid: string; at: number; flags: Record<FlagKey, boolean> } | null = null;

/** Feature flags for the signed-in user. Everything is off until the server answers, so unfinished features never flash. */
export function useFlags(): { on: (key: FlagKey) => boolean; ready: boolean } {
  const { user } = useAuth();
  const [flags, setFlags] = useState<Record<FlagKey, boolean> | null>(cached && user && cached.uid === user.uid ? cached.flags : null);

  useEffect(() => {
    if (!user) return;
    if (cached && cached.uid === user.uid && Date.now() - cached.at < 60_000) {
      setFlags(cached.flags);
      return;
    }
    let cancelled = false;
    (async () => {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) return;
      const res = await fetch("/api/flags", { headers: { Authorization: `Bearer ${idToken}` } });
      if (!res.ok) return;
      const data = (await res.json()) as { flags: Record<FlagKey, boolean> };
      cached = { uid: user.uid, at: Date.now(), flags: data.flags };
      if (!cancelled) setFlags(data.flags);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user]);

  return { on: (key) => !!flags?.[key], ready: flags != null };
}

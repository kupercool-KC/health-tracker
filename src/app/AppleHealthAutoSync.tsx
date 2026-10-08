"use client";

import { useEffect } from "react";
import { useAuth } from "@/lib/firebase/useAuth";
import { isAppleHealthEnabled, syncAppleHealth } from "@/lib/health/appleHealth";

/** Syncs Apple Health when the signed-in native app opens or returns to the foreground. Renders nothing. */
export default function AppleHealthAutoSync() {
  const { user } = useAuth();
  useEffect(() => {
    if (!user || !isAppleHealthEnabled()) return;
    const run = () => {
      if (document.visibilityState === "visible") syncAppleHealth().catch(() => {});
    };
    run();
    document.addEventListener("visibilitychange", run);
    return () => document.removeEventListener("visibilitychange", run);
  }, [user]);
  return null;
}

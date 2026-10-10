"use client";

import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { useAuth } from "@/lib/firebase/useAuth";
import { isAppleHealthEnabled, syncAppleHealth } from "@/lib/health/appleHealth";

const EVERY_MS = 5 * 60 * 1000;

/**
 * Keeps Apple Health data fresh while the signed-in iOS app is in use: on open, every time the app returns to
 * the foreground (native app-state event, more reliable than the page visibility event in a webview), and every
 * 5 minutes while it stays open. Pull-to-refresh on Today forces an extra sync. Renders nothing.
 */
export default function AppleHealthAutoSync() {
  const { user } = useAuth();
  useEffect(() => {
    if (!user || !isAppleHealthEnabled()) return;
    const run = () => {
      if (document.visibilityState === "visible") syncAppleHealth().catch(() => {});
    };
    run();
    document.addEventListener("visibilitychange", run);
    const timer = window.setInterval(run, EVERY_MS);
    let remove: (() => void) | undefined;
    if (Capacitor.isNativePlatform()) {
      App.addListener("appStateChange", ({ isActive }) => {
        if (isActive) run();
      }).then((h) => (remove = () => h.remove()));
    }
    return () => {
      document.removeEventListener("visibilitychange", run);
      window.clearInterval(timer);
      remove?.();
    };
  }, [user]);
  return null;
}

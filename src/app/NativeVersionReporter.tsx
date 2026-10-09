"use client";

import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { auth } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/useAuth";

/** Tells the server which native build is running (once per launch). Renders nothing; does nothing in the browser. */
export default function NativeVersionReporter() {
  const { user } = useAuth();
  useEffect(() => {
    if (!user || !Capacitor.isNativePlatform()) return;
    try {
      if (sessionStorage.getItem("buildReported") === "1") return;
    } catch {
      /* storage unavailable — report anyway */
    }
    (async () => {
      const info = await App.getInfo();
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) return;
      const res = await fetch("/api/app/version", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ version: info.version, build: info.build, platform: Capacitor.getPlatform() }),
      });
      if (res.ok) {
        try {
          sessionStorage.setItem("buildReported", "1");
        } catch {
          /* ignore */
        }
      }
    })().catch(() => {});
  }, [user]);
  return null;
}

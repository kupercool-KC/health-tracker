"use client";

/**
 * Health Sync token management. Generating a token revokes any previous one
 * (old Shortcuts using it will start getting 401s) and shows the new
 * plaintext value exactly once — only its hash is ever stored.
 */
import { useState } from "react";
import Link from "next/link";
import { auth } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/useAuth";

export default function Settings() {
  const { user, loading: authLoading } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setError(null);
    setBusy(true);
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) throw new Error("Not signed in");
      const idToken = await currentUser.getIdToken();
      const res = await fetch("/api/settings/health-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      const data: { token: string } = await res.json();
      setToken(data.token);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setError(null);
    setBusy(true);
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) throw new Error("Not signed in");
      const idToken = await currentUser.getIdToken();
      const res = await fetch("/api/settings/health-token", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      setToken(null);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  if (authLoading) {
    return (
      <main>
        <p style={{ color: "var(--muted)" }}>Loading…</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main>
        <h1>Settings</h1>
        <p style={{ color: "var(--muted)" }}>
          <Link href="/">Sign in</Link> to manage your Health Sync token.
        </p>
      </main>
    );
  }

  return (
    <main>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1>Settings</h1>
        <Link href="/" style={{ color: "var(--accent)" }}>
          ← Log food
        </Link>
      </div>

      <h2 style={{ marginTop: 24 }}>Apple Health sync</h2>
      <p style={{ color: "var(--muted)" }}>
        Generate a personal token to paste into your iOS Shortcut. Generating a
        new one immediately revokes the previous one.
      </p>

      <button onClick={generate} disabled={busy}>
        {busy ? "Working…" : "Generate new token"}
      </button>
      {token && (
        <button onClick={revoke} disabled={busy} style={{ marginLeft: 8, background: "none", color: "var(--muted)" }}>
          Revoke
        </button>
      )}

      {error && <p style={{ color: "#ff6b6b" }}>{error}</p>}

      {token && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            borderRadius: 8,
            background: "var(--panel)",
            border: "1px solid var(--border)",
            wordBreak: "break-all",
            fontFamily: "monospace",
          }}
        >
          {token}
        </div>
      )}
      {token && (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>
          Copy this now — it won&apos;t be shown again. Paste it as the Shortcut&apos;s
          bearer token; you no longer need to include a userId in the request body.
        </p>
      )}
    </main>
  );
}

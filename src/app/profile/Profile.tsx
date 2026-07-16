"use client";

/**
 * Profile screen. Full 4-section spec (dietary profile, alerts, memory,
 * goals & display) is a later phase — this ships the Apple Health sync
 * token management (previously at /settings) as a working first section, so
 * the nav shell's third tab has real content rather than a placeholder.
 */
import { useState } from "react";
import Link from "next/link";
import { auth } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/useAuth";
import { useI18n } from "@/lib/i18n/useI18n";
import { isAdmin } from "@/lib/admin";

export default function Profile() {
  const { user, loading: authLoading, signIn, signOutUser } = useAuth();
  const { t } = useI18n();
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function copyToken() {
    if (!token) return;
    await navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

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
      setCopied(false);
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
        <p style={{ color: "var(--muted)" }}>{t("loading")}</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main>
        <h1>{t("navProfile")}</h1>
        <p style={{ color: "var(--muted)" }}>{t("signInPrompt")}</p>
        <button onClick={() => signIn()}>{t("signInWithGoogle")}</button>
      </main>
    );
  }

  return (
    <main>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1>{t("navProfile")}</h1>
        <button onClick={() => signOutUser()} style={{ background: "none", color: "var(--muted)" }}>
          {t("signOut")} ({user.displayName ?? user.email})
        </button>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Apple Health sync</h2>
        <p style={{ color: "var(--muted)" }}>
          Generate a personal token to paste into your Health Auto Export automation. Generating a
          new one immediately revokes the previous one.
        </p>

        <button onClick={generate} disabled={busy}>
          {busy ? "Working…" : "Generate new token"}
        </button>
        {token && (
          <button onClick={revoke} disabled={busy} style={{ marginInlineStart: 8, background: "none", color: "var(--muted)" }}>
            Revoke
          </button>
        )}

        {error && <p style={{ color: "#ff6b6b" }}>{error}</p>}

        {token && (
          <div style={{ marginTop: 16, display: "flex", gap: 8, alignItems: "flex-start" }}>
            <div
              style={{
                flex: 1,
                padding: 12,
                borderRadius: 8,
                background: "var(--bg-muted)",
                border: "0.5px solid var(--border)",
                wordBreak: "break-all",
                fontFamily: "monospace",
              }}
            >
              {token}
            </div>
            <button onClick={copyToken}>{copied ? "Copied!" : "Copy"}</button>
          </div>
        )}
        {token && (
          <p style={{ color: "var(--muted)", fontSize: 13 }}>
            Copy this now — it won&apos;t be shown again.
          </p>
        )}
      </div>

      {isAdmin(user.uid) && (
        <div className="card" style={{ marginTop: 16 }}>
          <Link href="/admin" style={{ color: "var(--protein)" }}>
            Admin settings →
          </Link>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <p style={{ color: "var(--muted)", margin: 0 }}>
          Dietary profile, alerts, memory, and goals sections are coming in a later update.
        </p>
      </div>
    </main>
  );
}

"use client";

/**
 * Nutrition-logging UI, gated behind Firebase Auth (Google sign-in). Type
 * what you ate (or attach a photo) and it POSTs to /api/nutrition with the
 * current user's Firebase ID token.
 */
import { useState } from "react";
import Link from "next/link";
import { auth } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/useAuth";
import { uploadNutritionImage } from "@/lib/firebase/uploadImage";
import type { NutritionEntry } from "@/lib/types";

export default function NutritionLogger() {
  const { user, loading: authLoading, signIn, signOutUser } = useAuth();
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [entries, setEntries] = useState<NutritionEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) throw new Error("Not signed in");
      const token = await currentUser.getIdToken();
      const imageUrl = file ? await uploadNutritionImage(currentUser.uid, file) : undefined;

      const res = await fetch("/api/nutrition", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ text: text || undefined, imageUrl }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);

      const entry: NutritionEntry = await res.json();
      setEntries((prev) => [entry, ...prev]);
      setText("");
      setFile(null);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  const totals = entries.reduce(
    (acc, e) => ({ calories: acc.calories + e.calories, protein: acc.protein + e.protein }),
    { calories: 0, protein: 0 },
  );

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
        <h1>Health Tracker</h1>
        <p style={{ color: "var(--muted)" }}>Sign in to log nutrition and view your data.</p>
        <button onClick={() => signIn()}>Sign in with Google</button>
      </main>
    );
  }

  return (
    <main>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1>Health Tracker</h1>
        <div style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
          <Link href="/dashboard" style={{ color: "var(--accent)" }}>
            Dashboard →
          </Link>
          <button onClick={() => signOutUser()} style={{ background: "none", color: "var(--muted)" }}>
            Sign out ({user.displayName ?? user.email})
          </button>
        </div>
      </div>
      <p style={{ color: "var(--muted)" }}>
        Today: {Math.round(totals.calories)} kcal · {Math.round(totals.protein)} g protein
      </p>

      <form onSubmit={submit} style={{ display: "grid", gap: 8 }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. two eggs and a slice of toast"
          rows={3}
          style={{ padding: 8, borderRadius: 8, background: "var(--panel)", color: "var(--text)", border: "1px solid var(--border)" }}
        />
        <input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button type="submit" disabled={busy || (!text && !file)}>
          {busy ? "Logging…" : "Log it"}
        </button>
      </form>

      {error && <p style={{ color: "#ff6b6b" }}>{error}</p>}

      <ul style={{ listStyle: "none", padding: 0, marginTop: 24 }}>
        {entries.map((e) => (
          <li key={e.id} style={{ padding: 12, borderBottom: "1px solid var(--border)" }}>
            <strong>{e.description}</strong>
            <div style={{ color: "var(--muted)" }}>
              {Math.round(e.calories)} kcal · {Math.round(e.protein)} g protein
              {e.confidence != null && ` · ${Math.round(e.confidence * 100)}% conf`}
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}

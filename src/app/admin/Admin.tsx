"use client";

/**
 * Admin config for the nutrition parser (system prompt / model / sampling
 * params). Gated to ADMIN_UID both here and in firestore.rules — this page
 * hides itself for anyone else, but the real enforcement is the rule.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/useAuth";
import { isAdmin } from "@/lib/admin";
import { DEFAULT_NUTRITION_PARSER_CONFIG, type NutritionParserConfig } from "@/lib/nutrition/configDefaults";

const CONFIG_REF_PATH = ["appConfig", "nutritionParser"] as const;

export default function Admin() {
  const { user, loading: authLoading } = useAuth();
  const [config, setConfig] = useState<NutritionParserConfig>(DEFAULT_NUTRITION_PARSER_CONFIG);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!user || !isAdmin(user.uid)) {
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const ref = doc(db, CONFIG_REF_PATH[0], CONFIG_REF_PATH[1]);
        const snap = await getDoc(ref);
        const stored = snap.data() as Partial<NutritionParserConfig> | undefined;
        setConfig({ ...DEFAULT_NUTRITION_PARSER_CONFIG, ...stored });
      } catch (err) {
        setError(String(err instanceof Error ? err.message : err));
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const ref = doc(db, CONFIG_REF_PATH[0], CONFIG_REF_PATH[1]);
      await setDoc(ref, { ...config, updatedAt: new Date().toISOString() });
      setSaved(true);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  if (authLoading || loading) {
    return (
      <main>
        <p style={{ color: "var(--muted)" }}>Loading…</p>
      </main>
    );
  }

  if (!user || !isAdmin(user.uid)) {
    return (
      <main>
        <h1>Admin</h1>
        <p style={{ color: "var(--muted)" }}>Not authorized.</p>
      </main>
    );
  }

  return (
    <main>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1>Admin</h1>
        <Link href="/profile" style={{ color: "var(--protein)" }}>
          ← Profile
        </Link>
      </div>

      <div className="card" style={{ marginTop: 16, display: "grid", gap: 12 }}>
        <h2 style={{ margin: 0 }}>Nutrition parser</h2>

        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>System prompt</span>
          <textarea
            value={config.systemPrompt}
            onChange={(e) => setConfig((c) => ({ ...c, systemPrompt: e.target.value }))}
            rows={12}
            style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)", fontFamily: "monospace", fontSize: 13 }}
          />
        </label>

        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>Model</span>
          <input
            value={config.model}
            onChange={(e) => setConfig((c) => ({ ...c, model: e.target.value }))}
            style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
          />
        </label>

        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>Temperature (0 = most consistent, 2 = most varied)</span>
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={config.temperature}
            onChange={(e) => setConfig((c) => ({ ...c, temperature: Number(e.target.value) }))}
            style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
          />
        </label>

        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>Seed</span>
          <input
            type="number"
            value={config.seed}
            onChange={(e) => setConfig((c) => ({ ...c, seed: Number(e.target.value) }))}
            style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
          />
        </label>

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            onClick={() => setConfig(DEFAULT_NUTRITION_PARSER_CONFIG)}
            disabled={busy}
            style={{ background: "none", color: "var(--muted)" }}
          >
            Reset to default
          </button>
        </div>

        {saved && <p style={{ color: "var(--burned)" }}>Saved.</p>}
        {error && <p style={{ color: "#ff6b6b" }}>{error}</p>}
      </div>
    </main>
  );
}

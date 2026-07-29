"use client";

/**
 * Today dashboard: 4 metric cards, meals table (+ inline add-meal form —
 * this becomes the chat FAB's "log a meal" mode in a later phase), and a
 * workouts section synced from Apple Health via Health Auto Export.
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import { auth } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/useAuth";
import { useI18n } from "@/lib/i18n/useI18n";
import { getMealDay, getWorkoutsForDate, localDateKey } from "@/lib/dashboard/queries";
import { getUserGoals } from "@/lib/profile/queries";
import type { MealDay, UserProfile, Workout } from "@/lib/types";

function MetricCard({
  label,
  value,
  goal,
  sub,
  colorVar,
}: {
  label: string;
  value: number;
  goal?: number;
  sub: string;
  colorVar: string;
}) {
  const ratio = goal ? value / goal : undefined;
  const pct = ratio != null ? Math.min(100, Math.round(ratio * 100)) : undefined;
  const overflow = ratio != null && ratio > 1;

  return (
    <div className="card">
      <div className="metric-label">{label}</div>
      <div className="metric-value" style={{ color: colorVar }}>
        {Math.round(value)}
      </div>
      <div style={{ color: "var(--muted)", fontSize: 13 }}>{sub}</div>
      {pct != null && (
        <div className="progress-track">
          <div
            className="progress-fill"
            style={{ width: `${pct}%`, background: colorVar, opacity: overflow ? 1 : 0.85 }}
          />
        </div>
      )}
    </div>
  );
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function formatPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}/km`;
}

export default function Today() {
  const { user, loading: authLoading, signIn } = useAuth();
  const { t } = useI18n();

  const [mealDay, setMealDay] = useState<MealDay | null>(null);
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [goals, setGoals] = useState<Pick<UserProfile, "calorieGoal" | "proteinGoal">>({
    calorieGoal: 1950,
    proteinGoal: 145,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [workoutText, setWorkoutText] = useState("");
  const [workoutFile, setWorkoutFile] = useState<File | null>(null);
  const [workoutBusy, setWorkoutBusy] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCalories, setEditCalories] = useState("");
  const [editProtein, setEditProtein] = useState("");

  const load = useCallback(async (uid: string) => {
    setLoading(true);
    setError(null);
    try {
      const date = localDateKey();
      const [day, w, g] = await Promise.all([
        getMealDay(uid, date),
        getWorkoutsForDate(uid, date),
        getUserGoals(uid),
      ]);
      setMealDay(day);
      setWorkouts(w);
      setGoals(g);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) load(user.uid);
  }, [user, load]);

  async function submitMeal(e: React.FormEvent | React.KeyboardEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) throw new Error("Not signed in");
      const idToken = await currentUser.getIdToken();

      let imageUrl: string | undefined;
      if (file) {
        const { uploadNutritionImage } = await import("@/lib/firebase/uploadImage");
        imageUrl = await uploadNutritionImage(currentUser.uid, file);
      }

      const res = await fetch("/api/nutrition", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ text: text || undefined, imageUrl, date: localDateKey() }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);

      setText("");
      setFile(null);
      await load(currentUser.uid);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteMeal(entryId: string) {
    const currentUser = auth.currentUser;
    if (!currentUser || !window.confirm(t("deleteMealConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch("/api/nutrition", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ date: localDateKey(), entryId }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      await load(currentUser.uid);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  function startEditMeal(entryId: string, calories: number, protein: number) {
    setEditingId(entryId);
    setEditCalories(String(Math.round(calories)));
    setEditProtein(String(Math.round(protein)));
  }

  async function saveMealEdit(entryId: string) {
    const currentUser = auth.currentUser;
    if (!currentUser) return;
    setBusy(true);
    setError(null);
    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch("/api/nutrition", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          date: localDateKey(),
          entryId,
          changes: { calories: Number(editCalories) || 0, protein: Number(editProtein) || 0 },
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      setEditingId(null);
      await load(currentUser.uid);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  async function submitWorkout(e: React.FormEvent | React.KeyboardEvent) {
    e.preventDefault();
    setWorkoutBusy(true);
    setError(null);
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) throw new Error("Not signed in");
      const idToken = await currentUser.getIdToken();

      let imageUrl: string | undefined;
      if (workoutFile) {
        const { uploadWorkoutImage } = await import("@/lib/firebase/uploadImage");
        imageUrl = await uploadWorkoutImage(currentUser.uid, workoutFile);
      }

      const res = await fetch("/api/workouts", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ text: workoutText || undefined, imageUrl, date: localDateKey() }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);

      setWorkoutText("");
      setWorkoutFile(null);
      await load(currentUser.uid);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setWorkoutBusy(false);
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
        <h1>{t("today")}</h1>
        <p style={{ color: "var(--muted)" }}>{t("signInPrompt")}</p>
        <button onClick={() => signIn()}>{t("signInWithGoogle")}</button>
      </main>
    );
  }

  const totals = mealDay?.totals ?? { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const burned = workouts.reduce((sum, w) => sum + (w.calories ?? 0), 0);
  const net = totals.calories - burned;
  const lastSynced = workouts
    .map((w) => w.syncedAt)
    .sort()
    .at(-1);

  return (
    <main>
      <h1>{t("today")}</h1>

      {error && <p style={{ color: "#ff6b6b" }}>{error}</p>}

      {loading ? (
        <p style={{ color: "var(--muted)" }}>{t("loading")}</p>
      ) : (
        <>
          <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <MetricCard
              label={t("calories")}
              value={totals.calories}
              goal={goals.calorieGoal}
              sub={`${Math.round(totals.calories)} / ${goals.calorieGoal} ${t("goal")} · ${Math.max(0, Math.round(goals.calorieGoal - totals.calories))} ${t("remaining")}`}
              colorVar="var(--calories)"
            />
            <MetricCard
              label={t("protein")}
              value={totals.protein}
              goal={goals.proteinGoal}
              sub={`${Math.round(totals.protein)}g / ${goals.proteinGoal}g · ${totals.protein >= goals.proteinGoal ? t("surplus") : t("deficit")} ${Math.abs(Math.round(totals.protein - goals.proteinGoal))}g`}
              colorVar="var(--protein)"
            />
            <MetricCard
              label={t("burned")}
              value={burned}
              sub={`${Math.round(burned)} kcal`}
              colorVar="var(--burned)"
            />
            <MetricCard
              label={t("net")}
              value={net}
              sub={`${Math.round(totals.calories)} − ${Math.round(burned)}`}
              colorVar="var(--net)"
            />
          </section>

          <section style={{ marginTop: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <h2 style={{ margin: 0 }}>{t("meals")}</h2>
            </div>

            <form onSubmit={submitMeal} className="card" style={{ marginTop: 8, display: "grid", gap: 8 }}>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && (text || file) && !busy) {
                    submitMeal(e);
                  }
                }}
                placeholder={t("addMealPlaceholder")}
                rows={2}
                style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
              />
              <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <span
                  style={{
                    border: "0.5px solid var(--border)",
                    borderRadius: 8,
                    padding: "8px 14px",
                    background: "var(--panel)",
                  }}
                >
                  {t("chooseFile")}
                </span>
                <span style={{ color: "var(--muted)", fontSize: 13 }}>{file?.name}</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  style={{ display: "none" }}
                />
              </label>
              <button type="submit" disabled={busy || (!text && !file)}>
                {busy ? t("logging") : t("logIt")}
              </button>
            </form>

            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
              <thead>
                <tr style={{ color: "var(--muted)", textAlign: "left", fontSize: 13 }}>
                  <th style={{ padding: "8px 4px" }}>{t("time")}</th>
                  <th style={{ padding: "8px 4px" }}>{t("meal")}</th>
                  <th style={{ padding: "8px 4px" }}>{t("calories")}</th>
                  <th style={{ padding: "8px 4px" }}>{t("protein")}</th>
                  <th style={{ padding: "8px 4px" }} />
                </tr>
              </thead>
              <tbody>
                {(mealDay?.entries ?? []).map((entry) => (
                  <Fragment key={entry.id}>
                    <tr
                      onClick={() => editingId !== entry.id && setExpandedId(expandedId === entry.id ? null : entry.id)}
                      style={{ borderTop: "0.5px solid var(--border)", cursor: editingId === entry.id ? "default" : "pointer" }}
                    >
                      <td style={{ padding: "8px 4px", color: "var(--muted)" }}>
                        {new Date(entry.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </td>
                      <td style={{ padding: "8px 4px" }}>{entry.name}</td>
                      {editingId === entry.id ? (
                        <>
                          <td style={{ padding: "8px 4px" }}>
                            <input
                              type="number"
                              value={editCalories}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => setEditCalories(e.target.value)}
                              style={{ width: 64, padding: 4, borderRadius: 6, border: "0.5px solid var(--border)" }}
                            />
                          </td>
                          <td style={{ padding: "8px 4px" }}>
                            <input
                              type="number"
                              value={editProtein}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => setEditProtein(e.target.value)}
                              style={{ width: 56, padding: 4, borderRadius: 6, border: "0.5px solid var(--border)" }}
                            />
                          </td>
                        </>
                      ) : (
                        <>
                          <td style={{ padding: "8px 4px" }}>{Math.round(entry.calories)}</td>
                          <td style={{ padding: "8px 4px" }}>{Math.round(entry.protein)}g</td>
                        </>
                      )}
                      <td style={{ padding: "8px 4px", whiteSpace: "nowrap" }}>
                        {editingId === entry.id ? (
                          <>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                saveMealEdit(entry.id);
                              }}
                              disabled={busy}
                              style={{ border: "none", background: "none", color: "var(--protein)", padding: 2 }}
                              aria-label={t("save")}
                            >
                              ✓
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingId(null);
                              }}
                              disabled={busy}
                              style={{ border: "none", background: "none", color: "var(--muted)", padding: 2 }}
                              aria-label={t("close")}
                            >
                              ✕
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                startEditMeal(entry.id, entry.calories, entry.protein);
                              }}
                              disabled={busy}
                              style={{ border: "none", background: "none", padding: 2 }}
                              aria-label={t("edit")}
                            >
                              ✏️
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteMeal(entry.id);
                              }}
                              disabled={busy}
                              style={{ border: "none", background: "none", color: "var(--calories)", padding: 2 }}
                              aria-label={t("deleteMeal")}
                            >
                              ✕
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                    {expandedId === entry.id && (
                      <tr>
                        <td colSpan={5} style={{ padding: "0 4px 8px", color: "var(--muted)", fontSize: 13 }}>
                          {entry.carbs != null && `${t("carbs")} ${Math.round(entry.carbs)}g · `}
                          {entry.fat != null && `${t("fat")} ${Math.round(entry.fat)}g · `}
                          {entry.fiber != null && `${t("fiber")} ${Math.round(entry.fiber)}g · `}
                          {entry.confidence != null && `${Math.round(entry.confidence * 100)}% ${t("confidence")}`}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: "0.5px solid var(--border)", fontWeight: 700 }}>
                  <td style={{ padding: "8px 4px" }} colSpan={2}>
                    {t("total")}
                  </td>
                  <td style={{ padding: "8px 4px" }}>{Math.round(totals.calories)}</td>
                  <td style={{ padding: "8px 4px" }}>{Math.round(totals.protein)}g</td>
                  <td style={{ padding: "8px 4px" }} />
                </tr>
              </tfoot>
            </table>
          </section>

          <section style={{ marginTop: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <h2 style={{ margin: 0 }}>{t("workouts")}</h2>
              <button onClick={() => user && load(user.uid)}>{t("refresh")}</button>
            </div>
            {lastSynced && (
              <p style={{ color: "var(--muted)", fontSize: 13 }}>
                {t("lastSynced")}: {new Date(lastSynced).toLocaleString()}
              </p>
            )}
            {workouts.length === 0 ? (
              <p style={{ color: "var(--muted)" }}>{t("noWorkoutsToday")}</p>
            ) : (
              workouts.map((w) => (
                <div key={w.id} className="card" style={{ marginTop: 8 }}>
                  <strong>{w.type}</strong>
                  <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 4 }}>
                    {w.distance != null && `${(w.distance / 1000).toFixed(1)} km · `}
                    {w.pace != null && `${formatPace(w.pace)} · `}
                    {formatDuration(w.duration)}
                    {w.heartRate?.avg != null && ` · avg HR ${Math.round(w.heartRate.avg)}`}
                    {w.calories != null && ` · ${Math.round(w.calories)} kcal`}
                    {w.elevationGain != null && ` · +${Math.round(w.elevationGain)}m`}
                    {w.source === "manual" && ` · ${t("manuallyLogged")}`}
                  </div>
                </div>
              ))
            )}

            <h3 style={{ marginTop: 16, marginBottom: 0 }}>{t("logWorkout")}</h3>
            <form onSubmit={submitWorkout} className="card" style={{ marginTop: 8, display: "grid", gap: 8 }}>
              <textarea
                value={workoutText}
                onChange={(e) => setWorkoutText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && (workoutText || workoutFile) && !workoutBusy) {
                    submitWorkout(e);
                  }
                }}
                placeholder={t("workoutPlaceholder")}
                rows={2}
                style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }}
              />
              <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <span
                  style={{
                    border: "0.5px solid var(--border)",
                    borderRadius: 8,
                    padding: "8px 14px",
                    background: "var(--panel)",
                  }}
                >
                  {t("chooseFile")}
                </span>
                <span style={{ color: "var(--muted)", fontSize: 13 }}>{workoutFile?.name}</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => setWorkoutFile(e.target.files?.[0] ?? null)}
                  style={{ display: "none" }}
                />
              </label>
              <button type="submit" disabled={workoutBusy || (!workoutText && !workoutFile)}>
                {workoutBusy ? t("logging") : t("logIt")}
              </button>
            </form>
          </section>
        </>
      )}
    </main>
  );
}

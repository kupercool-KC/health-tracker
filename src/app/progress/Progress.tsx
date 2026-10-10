"use client";

/**
 * Progress screen (the former Weight tab): goal header, timeline chart, weekly scorecard and the
 * "expected vs actual" explanation. All numbers come from metrics/current (src/lib/metrics/compute.ts);
 * no LLM is involved here. Weigh-ins stay at the bottom.
 */
import AppleSignInButton from "@/app/AppleSignInButton";
import Weight from "@/app/weight/Weight";
import { useCallback, useEffect, useState } from "react";
import { doc, setDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/useAuth";
import { useI18n } from "@/lib/i18n/useI18n";
import { dayLabel } from "@/lib/dateLabels";
import type { MetricsCurrent } from "@/lib/types";

type WeightBlock = NonNullable<MetricsCurrent["weight"]>;
const DAY_MS = 86_400_000;
const ts = (d: string) => new Date(`${d}T12:00:00Z`).getTime();
const dateKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const fill = (tpl: string, vars: Record<string, string | number>) => Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), tpl);

function statusColor(s: WeightBlock["status"]) {
  return s === "behind" ? "var(--danger)" : s === "notEnoughData" ? "var(--muted)" : "var(--burned)";
}

function TimelineChart({ w, startDate, t }: { w: WeightBlock; startDate: string; t: (k: "progressLegendTrend" | "progressLegendPlan") => string }) {
  const W = 340, H = 170, padL = 34, padR = 12, padT = 12, padB = 24;
  const today = dateKey(Date.now());
  const endDate = [w.targetDate, w.etaDate, today].filter(Boolean).sort().at(-1)!;
  const t0 = ts(startDate), t1 = Math.max(ts(endDate), t0 + 7 * DAY_MS);
  const values = [w.startKg ?? w.latestKg, w.targetKg, ...w.series.flatMap((p) => [p.kg, p.trend])].filter((v): v is number => v != null);
  const lo = Math.floor(Math.min(...values) - 1), hi = Math.ceil(Math.max(...values) + 1);
  const x = (d: string) => padL + ((ts(d) - t0) / (t1 - t0)) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);
  const trendPts = w.series.map((p) => `${x(p.date).toFixed(1)},${y(p.trend).toFixed(1)}`).join(" ");
  const ticks = [lo, Math.round((lo + hi) / 2), hi];
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="weight timeline" style={{ display: "block" }}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth="0.5" />
            <text x={padL - 4} y={y(v) + 3} textAnchor="end" fontSize="9" fill="var(--muted)">{v}</text>
          </g>
        ))}
        {w.targetKg != null && (
          <line x1={padL} x2={W - padR} y1={y(w.targetKg)} y2={y(w.targetKg)} stroke="var(--burned)" strokeWidth="1" strokeDasharray="2 3" />
        )}
        {w.targetKg != null && w.targetDate && w.startKg != null && (
          <line x1={x(startDate)} y1={y(w.startKg)} x2={x(w.targetDate)} y2={y(w.targetKg)} stroke="var(--muted)" strokeWidth="1.2" strokeDasharray="5 4" />
        )}
        <line x1={x(today)} x2={x(today)} y1={padT} y2={H - padB} stroke="var(--line)" strokeWidth="1" />
        {w.series.map((p) => (
          <circle key={p.date} cx={x(p.date)} cy={y(p.kg)} r="2.4" fill="var(--calories)" opacity="0.55" />
        ))}
        <polyline points={trendPts} fill="none" stroke="var(--calories)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {w.series.length > 0 && <circle cx={x(w.series.at(-1)!.date)} cy={y(w.series.at(-1)!.trend)} r="4" fill="var(--calories)" />}
        <text x={padL} y={H - 6} fontSize="9" fill="var(--muted)">{dayLabel(startDate)}</text>
        <text x={W - padR} y={H - 6} fontSize="9" fill="var(--muted)" textAnchor="end">{dayLabel(endDate)}</text>
      </svg>
      <div style={{ display: "flex", gap: 14, fontSize: 12, color: "var(--muted)" }}>
        <span><span style={{ color: "var(--calories)" }}>■</span> {t("progressLegendTrend")}</span>
        {w.targetKg != null && w.targetDate && <span>- - {t("progressLegendPlan")}</span>}
      </div>
    </div>
  );
}

export default function Progress() {
  const { user, loading: authLoading, authError, signIn } = useAuth();
  const { t } = useI18n();
  const [metrics, setMetrics] = useState<MetricsCurrent | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [tw, setTw] = useState("");
  const [td, setTd] = useState("");
  const [hint, setHint] = useState<string | null>(null);

  const load = useCallback(async () => {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) return;
    const res = await fetch("/api/metrics/refresh", { method: "POST", headers: { Authorization: `Bearer ${idToken}` } });
    if (res.ok) setMetrics(((await res.json()) as { metrics: MetricsCurrent | null }).metrics);
  }, []);
  useEffect(() => {
    if (!user) return;
    setLoading(true);
    load().catch(() => {}).finally(() => setLoading(false));
  }, [user, load]);

  if (authLoading) return <main><p style={{ color: "var(--muted)" }}>{t("loading")}</p></main>;
  if (!user) {
    return (
      <main>
        <h1>{t("navProgress")}</h1>
        <p style={{ color: "var(--muted)" }}>{t("signInPrompt")}</p>
        <button onClick={() => signIn()}>{t("signInWithGoogle")}</button>
        <AppleSignInButton />
        {authError && <p style={{ color: "#ff6b6b", fontSize: 13 }}>{t("signInFailed")}: {authError}</p>}
      </main>
    );
  }

  const w = metrics?.weight;

  async function saveTarget() {
    if (!user || !w) return;
    const kg = Number(tw);
    if (!Number.isFinite(kg) || kg < 30 || kg > 250) return;
    // Safe pace: at most 1% of body weight per week.
    const start = w.latestKg;
    const weeks = Math.ceil(Math.abs(kg - start) / (start * 0.01));
    const earliest = dateKey(Date.now() + weeks * 7 * DAY_MS);
    let date = td || earliest;
    if (date < earliest && Math.abs(kg - start) > 0.5) {
      setHint(fill(t("progressSafePace"), { date: earliest }));
      setTd(earliest);
      return;
    }
    await setDoc(
      doc(db, "users", user.uid, "meta", "profile"),
      { targetWeightKg: kg, targetDate: date, startWeightKg: start, targetSetAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { merge: true },
    );
    setEditing(false);
    setHint(null);
    await fetch("/api/metrics/refresh", { method: "POST", headers: { Authorization: `Bearer ${await auth.currentUser?.getIdToken()}` } }).catch(() => {});
    await load();
  }

  const quick = (weeks: number) => setTd(dateKey(Date.now() + weeks * 7 * DAY_MS));
  const fmtKg = (n: number | undefined) => (n == null ? "–" : `${n > 0 ? "+" : ""}${n}`);

  return (
    <main>
      <h1>{t("navProgress")}</h1>

      {loading ? (
        <p style={{ color: "var(--muted)" }}>{t("loading")}</p>
      ) : !metrics || metrics.daysWithData < 7 ? (
        <div className="card" style={{ marginTop: 12 }}>
          <p style={{ color: "var(--muted)", margin: 0 }}>{fill(t("progressEmpty"), { n: metrics?.daysWithData ?? 0 })}</p>
        </div>
      ) : (
        <>
          {/* Goal header */}
          <div className="card" style={{ marginTop: 12, display: "grid", gap: 8 }}>
            {w ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 18 }}>
                    <bdi dir="ltr">{w.trendKg} {t("unitKg")}</bdi>
                    {w.targetKg != null && <span style={{ color: "var(--muted)", fontWeight: 400 }}> → <bdi dir="ltr">{w.targetKg} {t("unitKg")}</bdi></span>}
                  </strong>
                  {w.targetKg != null && (
                    <span style={{ fontSize: 12, padding: "2px 10px", borderRadius: 99, border: `1px solid ${statusColor(w.status)}`, color: statusColor(w.status) }}>
                      {t(`progressStatus_${w.status}` as "progressStatus_onTrack")}
                    </span>
                  )}
                </div>
                {w.progressPct != null && (
                  <>
                    <div style={{ height: 6, borderRadius: 3, background: "var(--line)", overflow: "hidden" }} role="presentation">
                      <div style={{ width: `${w.progressPct}%`, height: "100%", background: "var(--burned)" }} />
                    </div>
                    <span style={{ color: "var(--muted)", fontSize: 12 }}>{fill(t("progressPercentDone"), { n: w.progressPct })}</span>
                  </>
                )}
                {w.etaDate && <span style={{ fontSize: 13 }}>{fill(t("progressEta"), { date: dayLabel(w.etaDate) })}</span>}
                {w.requiredDailyBalanceKcal != null && w.targetDate && Math.abs(w.requiredDailyBalanceKcal) > 0 && (
                  <span style={{ fontSize: 13, color: "var(--muted)" }}>
                    {fill(t(w.requiredDailyBalanceKcal < 0 ? "progressNeeded" : "progressNeededUp"), { date: dayLabel(w.targetDate), n: Math.abs(w.requiredDailyBalanceKcal) })}
                  </span>
                )}
                {w.targetKg == null && <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("progressNoTargetHint")}</span>}
                <div>
                  <button onClick={() => { setEditing((v) => !v); setTw(String(w.targetKg ?? "")); setTd(w.targetDate ?? ""); setHint(null); }}>
                    {w.targetKg == null ? t("progressSetTarget") : t("progressEditTarget")}
                  </button>
                </div>
                {editing && (
                  <div style={{ display: "grid", gap: 8 }}>
                    <label style={{ display: "grid", gap: 4 }}>
                      <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("progressTargetWeight")}</span>
                      <input id="target-kg" type="number" inputMode="decimal" value={tw} onChange={(e) => setTw(e.target.value)} style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }} />
                    </label>
                    <label style={{ display: "grid", gap: 4 }}>
                      <span style={{ color: "var(--muted)", fontSize: 13 }}>{t("progressTargetDate")}</span>
                      <input id="target-date" type="date" value={td} onChange={(e) => setTd(e.target.value)} style={{ padding: 8, borderRadius: 8, border: "0.5px solid var(--border)" }} />
                    </label>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {[8, 12, 16].map((n) => (
                        <button key={n} type="button" onClick={() => quick(n)}>{fill(t("progressQuickWeeks"), { n })}</button>
                      ))}
                    </div>
                    {hint && <span style={{ color: "var(--warning, #b7791f)", fontSize: 13 }}>{hint}</span>}
                    <div><button onClick={saveTarget}>{t("progressSaveTarget")}</button></div>
                  </div>
                )}
              </>
            ) : (
              <span style={{ color: "var(--muted)" }}>{t("weighInNoEntries")}</span>
            )}
          </div>

          {/* Timeline */}
          {w && w.series.length >= 2 && (
            <div className="card" style={{ marginTop: 12 }}>
              <TimelineChart w={w} startDate={w.series[0].date} t={t} />
            </div>
          )}

          {/* Scorecard */}
          <div className="card" style={{ marginTop: 12, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <strong>{t("progressScorecard")}</strong>
              <span style={{ color: "var(--muted)", fontSize: 12 }}>{t("progressSc7")} · {t("progressSc28")}</span>
            </div>
            {[
              { k: "progressScLogged" as const, a: `${metrics.adherence.loggedDays7}/7`, b: `${metrics.adherence.loggedDays28}/28` },
              { k: "progressScCalories" as const, a: `${metrics.adherence.calorieDays7}/${metrics.adherence.loggedDays7}`, b: `${metrics.adherence.calorieDays28}/${metrics.adherence.loggedDays28}` },
              { k: "progressScProtein" as const, a: `${metrics.adherence.proteinDays7}/${metrics.adherence.loggedDays7}`, b: `${metrics.adherence.proteinDays28}/${metrics.adherence.loggedDays28}` },
              { k: "progressScWorkouts" as const, a: String(metrics.workouts7.count), b: `${metrics.workoutsPrev28.perWeek}/wk` },
              ...(metrics.avg7.sleepMin ? [{ k: "progressScSleep" as const, a: `${(metrics.avg7.sleepMin / 60).toFixed(1)}h`, b: metrics.avg28.sleepMin ? `${(metrics.avg28.sleepMin / 60).toFixed(1)}h` : "–" }] : []),
              ...(metrics.avg7.steps ? [{ k: "progressScSteps" as const, a: String(metrics.avg7.steps), b: String(metrics.avg28.steps ?? "–") }] : []),
              ...(w?.weeklyRateKg != null ? [{ k: "progressScWeight" as const, a: `${fmtKg(w.weeklyRateKg)} ${t("unitKg")}`, b: "" }] : []),
            ].map((r) => (
              <div key={r.k} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 14 }}>
                <span>{t(r.k)}</span>
                <bdi dir="ltr" style={{ color: "var(--muted)" }}>{r.a}{r.b ? ` · ${r.b}` : ""}</bdi>
              </div>
            ))}
            {metrics.logging.streak >= 2 && <span style={{ color: "var(--muted)", fontSize: 12 }}>{fill(t("progressStreak"), { n: metrics.logging.streak })}</span>}
          </div>

          {/* Expected vs actual */}
          {w?.expectedChange28Kg != null && w.actualChange28Kg != null && Math.abs(w.actualChange28Kg - w.expectedChange28Kg) > 1 && (
            <div className="card" style={{ marginTop: 12, display: "grid", gap: 4 }}>
              <strong>{t("progressExpectedTitle")}</strong>
              <span style={{ fontSize: 13, color: "var(--muted)" }}>
                {fill(t("progressExpectedBody"), { e: fmtKg(w.expectedChange28Kg), a: fmtKg(w.actualChange28Kg) })}
              </span>
            </div>
          )}
        </>
      )}

      <h2 style={{ marginTop: 24 }}>{t("progressWeighIns")}</h2>
      <Weight embedded />
    </main>
  );
}

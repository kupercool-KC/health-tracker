"use client";

/**
 * History screen: 7-day calendar strip (goal-status color dots), tap a day
 * for a full breakdown drawer, and a weekly/monthly/custom-range period
 * picker driving three charts — calories, protein (bars turn red on days
 * the protein goal was missed), and an aggregate day-by-day standing view.
 * Charts are hand-rolled inline SVG rather than a charting library — simple
 * gradient-filled bars, no new dependency needed for this.
 */
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/firebase/useAuth";
import { useI18n } from "@/lib/i18n/useI18n";
import {
  getMealDaysSince,
  getWorkoutsSince,
  localDateKey,
  localDateKeyDaysAgo,
} from "@/lib/dashboard/queries";
import { getUserGoals } from "@/lib/profile/queries";
import type { MealDay, UserProfile, Workout } from "@/lib/types";

interface DayInfo {
  date: string;
  calories: number;
  protein: number;
  burned: number;
  hasData: boolean;
  entries: MealDay["entries"];
  workouts: Workout[];
}

type Period = "weekly" | "monthly" | "custom";

/** Bounded — a personal app doesn't need to ever fetch more than this in one go. */
const MAX_FETCH_DAYS = 366;

function dayLabel(date: string): string {
  return `${date.slice(5, 7)}/${date.slice(8, 10)}`;
}

/** Shared gradient-filled bar chart for a single metric, with hover/tap tooltip. */
function MetricBarChart({
  days,
  valueKey,
  goal,
  label,
  colorVar,
  colorLightVar,
  missColorVar,
  missColorLightVar,
  unit,
}: {
  days: DayInfo[];
  valueKey: "calories" | "protein";
  goal: number;
  label: string;
  colorVar: string;
  colorLightVar: string;
  /** If set, bars for days that missed the goal (value < goal) use this color instead. */
  missColorVar?: string;
  missColorLightVar?: string;
  unit: string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const height = 140;
  const max = Math.max(goal, ...days.map((d) => d[valueKey]), 1) * 1.15;
  const barWidth = 100 / Math.max(days.length, 1);
  const goalY = height - (goal / max) * height;
  const gradId = `grad-${valueKey}-${colorVar.replace(/[^a-z]/gi, "")}`;
  const gradMissId = `${gradId}-miss`;

  return (
    <div className="card" style={{ marginTop: 16, position: "relative" }}>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
        <span style={{ color: colorVar }}>■</span> {label}
      </div>
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height }}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={colorLightVar} />
            <stop offset="100%" stopColor={colorVar} />
          </linearGradient>
          {missColorVar && (
            <linearGradient id={gradMissId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={missColorLightVar} />
              <stop offset="100%" stopColor={missColorVar} />
            </linearGradient>
          )}
        </defs>
        <line x1={0} y1={goalY} x2={100} y2={goalY} stroke={colorVar} strokeDasharray="2,2" strokeWidth={0.5} />
        {days.map((d, i) => {
          const val = d[valueKey];
          const barHeight = Math.max((val / max) * height, val > 0 ? 1 : 0);
          const x = i * barWidth;
          const missed = missColorVar && d.hasData && val < goal;
          return (
            <rect
              key={d.date}
              x={x + barWidth * 0.15}
              y={height - barHeight}
              width={barWidth * 0.7}
              height={barHeight}
              fill={missed ? `url(#${gradMissId})` : `url(#${gradId})`}
              opacity={hoverIdx === null || hoverIdx === i ? 0.95 : 0.45}
              onMouseEnter={() => setHoverIdx(i)}
              onClick={() => setHoverIdx(i)}
              style={{ cursor: "pointer" }}
            />
          );
        })}
      </svg>
      {hoverIdx != null && days[hoverIdx] && (
        <div
          style={{
            position: "absolute",
            top: 8,
            insetInlineEnd: 8,
            background: "var(--bg-muted)",
            border: "0.5px solid var(--border)",
            borderRadius: 8,
            padding: "6px 10px",
            fontSize: 12,
          }}
        >
          <bdi dir="ltr">
            {dayLabel(days[hoverIdx].date)} · {Math.round(days[hoverIdx][valueKey])}
            {unit}
          </bdi>
        </div>
      )}
    </div>
  );
}

/** Day-by-day "how am I doing vs both targets" strip — a color-coded bar per day. */
function AggregateChart({
  days,
  statusColor,
  label,
  statusText,
}: {
  days: DayInfo[];
  statusColor: (d: DayInfo) => string;
  label: string;
  statusText: (d: DayInfo) => string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const height = 48;
  const barWidth = 100 / Math.max(days.length, 1);

  return (
    <div className="card" style={{ marginTop: 16, position: "relative" }}>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>{label}</div>
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height }}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {days.map((d, i) => {
          const x = i * barWidth;
          return (
            <rect
              key={d.date}
              x={x + barWidth * 0.1}
              y={0}
              width={barWidth * 0.8}
              height={height}
              rx={2}
              fill={statusColor(d)}
              opacity={hoverIdx === null || hoverIdx === i ? 0.9 : 0.4}
              onMouseEnter={() => setHoverIdx(i)}
              onClick={() => setHoverIdx(i)}
              style={{ cursor: "pointer" }}
            />
          );
        })}
      </svg>
      {hoverIdx != null && days[hoverIdx] && (
        <div
          style={{
            position: "absolute",
            top: 8,
            insetInlineEnd: 8,
            background: "var(--bg-muted)",
            border: "0.5px solid var(--border)",
            borderRadius: 8,
            padding: "6px 10px",
            fontSize: 12,
            maxWidth: 200,
          }}
        >
          <bdi dir="ltr">{dayLabel(days[hoverIdx].date)}</bdi> — {statusText(days[hoverIdx])}
        </div>
      )}
    </div>
  );
}

export default function History() {
  const { user, loading: authLoading, signIn } = useAuth();
  const { t } = useI18n();

  const [days, setDays] = useState<DayInfo[]>([]);
  const [goals, setGoals] = useState<Pick<UserProfile, "calorieGoal" | "proteinGoal">>({
    calorieGoal: 1950,
    proteinGoal: 145,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("weekly");
  const [customFrom, setCustomFrom] = useState(localDateKeyDaysAgo(6));
  const [customTo, setCustomTo] = useState(localDateKey());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const range = useMemo(() => {
    if (period === "weekly") return { from: localDateKeyDaysAgo(6), to: localDateKey() };
    if (period === "monthly") return { from: localDateKeyDaysAgo(29), to: localDateKey() };
    return { from: customFrom, to: customTo };
  }, [period, customFrom, customTo]);

  useEffect(() => {
    if (!user) return;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [mealDays, workouts, g] = await Promise.all([
          getMealDaysSince(user.uid, range.from, range.to),
          getWorkoutsSince(user.uid, range.from, range.to),
          getUserGoals(user.uid),
        ]);
        setGoals(g);

        const mealByDate = new Map(mealDays.map((m) => [m.date, m]));
        const workoutsByDate = new Map<string, Workout[]>();
        for (const w of workouts) {
          workoutsByDate.set(w.date, [...(workoutsByDate.get(w.date) ?? []), w]);
        }

        const start = new Date(range.from);
        const end = new Date(range.to);
        const spanDays = Math.min(
          Math.max(Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1, 1),
          MAX_FETCH_DAYS,
        );

        const built: DayInfo[] = [];
        for (let i = 0; i < spanDays; i++) {
          const d = new Date(start);
          d.setDate(d.getDate() + i);
          const date = localDateKey(d);
          const meal = mealByDate.get(date);
          const dayWorkouts = workoutsByDate.get(date) ?? [];
          const burned = dayWorkouts.reduce((sum, w) => sum + (w.calories ?? 0), 0);
          built.push({
            date,
            calories: meal?.totals.calories ?? 0,
            protein: meal?.totals.protein ?? 0,
            burned,
            hasData: (meal?.entries.length ?? 0) > 0 || dayWorkouts.length > 0,
            entries: meal?.entries ?? [],
            workouts: dayWorkouts,
          });
        }
        setDays(built);
      } catch (err) {
        setError(String(err instanceof Error ? err.message : err));
      } finally {
        setLoading(false);
      }
    })();
  }, [user, range.from, range.to]);

  function statusColor(d: DayInfo): string {
    if (!d.hasData) return "var(--muted)";
    if (d.calories > goals.calorieGoal) return "var(--calories)";
    if (d.protein < goals.proteinGoal) return "var(--danger)";
    return "var(--burned)";
  }

  function statusText(d: DayInfo): string {
    if (!d.hasData) return t("noDataLogged");
    if (d.calories > goals.calorieGoal) return t("calorieGoalMissed");
    if (d.protein < goals.proteinGoal) return t("proteinGoalMissed");
    return t("allGoalsMet");
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
        <h1>{t("navHistory")}</h1>
        <p style={{ color: "var(--muted)" }}>{t("signInPrompt")}</p>
        <button onClick={() => signIn()}>{t("signInWithGoogle")}</button>
      </main>
    );
  }

  const last7 = days.slice(-7);
  const selected = days.find((d) => d.date === selectedDate) ?? null;
  const today = localDateKey();

  return (
    <main>
      <h1>{t("navHistory")}</h1>

      {error && <p style={{ color: "#ff6b6b" }}>{error}</p>}

      {loading ? (
        <p style={{ color: "var(--muted)" }}>{t("loading")}</p>
      ) : (
        <>
          <div style={{ display: "flex", gap: 6, marginTop: 16 }}>
            {last7.map((d) => {
              const isToday = d.date === today;
              const dayNum = Number(d.date.slice(8, 10));
              return (
                <button
                  key={d.date}
                  onClick={() => setSelectedDate(d.date)}
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 4,
                    padding: 8,
                    borderRadius: 8,
                    border: isToday ? "1.5px solid var(--text)" : "0.5px solid var(--border)",
                    background: isToday ? "var(--bg-muted)" : "var(--panel)",
                  }}
                >
                  <bdi dir="ltr" style={{ fontSize: 11, color: "var(--muted)" }}>
                    {dayNum}
                  </bdi>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor(d) }} />
                </button>
              );
            })}
          </div>

          <div style={{ display: "flex", gap: 12, fontSize: 12, color: "var(--muted)", marginTop: 8, flexWrap: "wrap" }}>
            <span>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "var(--burned)" }} /> {t("allGoalsMet")}
            </span>
            <span>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "var(--calories)" }} /> {t("calorieGoalMissed")}
            </span>
            <span>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "var(--danger)" }} /> {t("proteinGoalMissed")}
            </span>
            <span>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "var(--muted)" }} /> {t("noDataLogged")}
            </span>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 24, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={() => setPeriod("weekly")} style={{ fontWeight: period === "weekly" ? 700 : 400 }}>
              {t("last7Days")}
            </button>
            <button onClick={() => setPeriod("monthly")} style={{ fontWeight: period === "monthly" ? 700 : 400 }}>
              {t("last30Days")}
            </button>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="date"
                value={customFrom}
                max={customTo}
                onChange={(e) => {
                  setCustomFrom(e.target.value);
                  setPeriod("custom");
                }}
                style={{ padding: 6, borderRadius: 8, border: "0.5px solid var(--border)" }}
              />
              <span style={{ color: "var(--muted)" }}>–</span>
              <input
                type="date"
                value={customTo}
                min={customFrom}
                max={today}
                onChange={(e) => {
                  setCustomTo(e.target.value);
                  setPeriod("custom");
                }}
                style={{ padding: 6, borderRadius: 8, border: "0.5px solid var(--border)" }}
              />
            </span>
          </div>

          <MetricBarChart
            days={days}
            valueKey="calories"
            goal={goals.calorieGoal}
            label={t("caloriesVsGoal")}
            colorVar="var(--calories)"
            colorLightVar="var(--calories-light)"
            unit=" kcal"
          />
          <MetricBarChart
            days={days}
            valueKey="protein"
            goal={goals.proteinGoal}
            label={t("proteinVsGoal")}
            colorVar="var(--protein)"
            colorLightVar="var(--protein-light)"
            missColorVar="var(--danger)"
            missColorLightVar="var(--danger-light)"
            unit={t("unitG")}
          />
          <AggregateChart days={days} statusColor={statusColor} statusText={statusText} label={t("overallStanding")} />
        </>
      )}

      {selected && (
        <div
          className="card"
          style={{
            position: "fixed",
            top: 0,
            bottom: 0,
            insetInlineEnd: 0,
            width: 320,
            maxWidth: "90%",
            borderRadius: 0,
            padding: 16,
            overflowY: "auto",
            zIndex: 60,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <h2 style={{ margin: 0 }}>
              <bdi dir="ltr">{selected.date}</bdi>
            </h2>
            <button onClick={() => setSelectedDate(null)} style={{ border: "none", background: "none" }}>
              ✕
            </button>
          </div>
          <p style={{ color: "var(--muted)" }}>
            <bdi dir="ltr">
              {Math.round(selected.calories)} {t("calories")} · {Math.round(selected.protein)}
              {t("unitG")} {t("protein")}
            </bdi>
          </p>

          <h3>{t("meals")}</h3>
          {selected.entries.length === 0 ? (
            <p style={{ color: "var(--muted)" }}>{t("noWorkoutsToday")}</p>
          ) : (
            selected.entries.map((e) => (
              <div key={e.id} style={{ padding: "4px 0", borderTop: "0.5px solid var(--border)" }}>
                <strong>{e.name}</strong> —{" "}
                <bdi dir="ltr">
                  {Math.round(e.calories)} kcal, {Math.round(e.protein)}
                  {t("unitG")}
                </bdi>
              </div>
            ))
          )}

          <h3>{t("workouts")}</h3>
          {selected.workouts.length === 0 ? (
            <p style={{ color: "var(--muted)" }}>{t("noWorkoutsToday")}</p>
          ) : (
            selected.workouts.map((w) => (
              <div key={w.id} style={{ padding: "4px 0", borderTop: "0.5px solid var(--border)" }}>
                <strong>{w.type}</strong> —{" "}
                <bdi dir="ltr">
                  {Math.round(w.duration / 60)} min
                  {w.calories != null && `, ${Math.round(w.calories)} kcal`}
                </bdi>
              </div>
            ))
          )}
        </div>
      )}
    </main>
  );
}

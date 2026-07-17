"use client";

/**
 * History screen: 7-day calendar strip (goal-status color dots), tap a day
 * for a full breakdown drawer, and a 7/30-day toggle driving calorie/protein/
 * burned charts. Charts are hand-rolled inline SVG rather than a charting
 * library — simple bar/line shapes, no new dependency needed for this.
 */
import { useEffect, useState } from "react";
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

const WINDOW_DAYS = 30;

function CaloriesChart({
  days,
  calorieGoal,
  proteinGoal,
  calLabel,
  protLabel,
}: {
  days: DayInfo[];
  calorieGoal: number;
  proteinGoal: number;
  calLabel: string;
  protLabel: string;
}) {
  const height = 160;
  const maxCal = Math.max(calorieGoal, ...days.map((d) => d.calories), 1) * 1.1;
  const maxProt = Math.max(proteinGoal, ...days.map((d) => d.protein), 1) * 1.1;
  const barWidth = 100 / days.length;
  const goalY = height - (calorieGoal / maxCal) * height;

  const proteinPoints = days
    .map((d, i) => {
      const x = i * barWidth + barWidth / 2;
      const y = height - (d.protein / maxProt) * height;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", gap: 12, fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
        <span>
          <span style={{ color: "var(--calories)" }}>■</span> {calLabel}
        </span>
        <span>
          <span style={{ color: "var(--protein)" }}>─</span> {protLabel}
        </span>
      </div>
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{ width: "100%", height }}>
        <line x1={0} y1={goalY} x2={100} y2={goalY} stroke="var(--calories)" strokeDasharray="2,2" strokeWidth={0.5} />
        {days.map((d, i) => {
          const barHeight = (d.calories / maxCal) * height;
          const x = i * barWidth;
          return (
            <rect
              key={d.date}
              x={x + barWidth * 0.15}
              y={height - barHeight}
              width={barWidth * 0.7}
              height={barHeight}
              fill="var(--calories)"
              opacity={0.85}
            />
          );
        })}
        <polyline points={proteinPoints} fill="none" stroke="var(--protein)" strokeWidth={1} />
        {days.map((d, i) => {
          const x = i * barWidth + barWidth / 2;
          const y = height - (d.protein / maxProt) * height;
          return <circle key={d.date} cx={x} cy={y} r={1.2} fill="var(--protein)" />;
        })}
      </svg>
    </div>
  );
}

function BurnedChart({ days, label }: { days: DayInfo[]; label: string }) {
  const height = 100;
  const max = Math.max(...days.map((d) => d.burned), 1) * 1.1;
  const barWidth = 100 / days.length;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
        <span style={{ color: "var(--burned)" }}>■</span> {label}
      </div>
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{ width: "100%", height }}>
        {days.map((d, i) => {
          const barHeight = (d.burned / max) * height;
          const x = i * barWidth;
          return (
            <rect
              key={d.date}
              x={x + barWidth * 0.15}
              y={height - barHeight}
              width={barWidth * 0.7}
              height={barHeight}
              fill="var(--burned)"
              opacity={0.85}
            />
          );
        })}
      </svg>
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
  const [range, setRange] = useState<7 | 30>(7);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const sinceDate = localDateKeyDaysAgo(WINDOW_DAYS - 1);
        const [mealDays, workouts, g] = await Promise.all([
          getMealDaysSince(user.uid, sinceDate),
          getWorkoutsSince(user.uid, sinceDate),
          getUserGoals(user.uid),
        ]);
        setGoals(g);

        const mealByDate = new Map(mealDays.map((m) => [m.date, m]));
        const workoutsByDate = new Map<string, Workout[]>();
        for (const w of workouts) {
          workoutsByDate.set(w.date, [...(workoutsByDate.get(w.date) ?? []), w]);
        }

        const built: DayInfo[] = [];
        for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
          const date = localDateKeyDaysAgo(i);
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
  }, [user]);

  function statusColor(d: DayInfo): string {
    if (!d.hasData) return "var(--muted)";
    if (d.calories > goals.calorieGoal) return "var(--calories)";
    if (d.protein < goals.proteinGoal) return "var(--protein)";
    return "var(--burned)";
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
  const chartDays = range === 7 ? last7 : days;
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
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>{dayNum}</span>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor(d) }} />
                </button>
              );
            })}
          </div>

          <div style={{ display: "flex", gap: 12, fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
            <span>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "var(--burned)" }} /> {t("allGoalsMet")}
            </span>
            <span>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "var(--calories)" }} /> {t("calorieGoalMissed")}
            </span>
            <span>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "var(--protein)" }} /> {t("proteinGoalMissed")}
            </span>
            <span>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "var(--muted)" }} /> {t("noDataLogged")}
            </span>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 24 }}>
            <button onClick={() => setRange(7)} style={{ fontWeight: range === 7 ? 700 : 400 }}>
              {t("last7Days")}
            </button>
            <button onClick={() => setRange(30)} style={{ fontWeight: range === 30 ? 700 : 400 }}>
              {t("last30Days")}
            </button>
          </div>

          <CaloriesChart
            days={chartDays}
            calorieGoal={goals.calorieGoal}
            proteinGoal={goals.proteinGoal}
            calLabel={t("caloriesVsGoal")}
            protLabel={t("proteinVsGoal")}
          />
          <BurnedChart days={chartDays} label={t("caloriesBurned")} />
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
            <h2 style={{ margin: 0 }}>{selected.date}</h2>
            <button onClick={() => setSelectedDate(null)} style={{ border: "none", background: "none" }}>
              ✕
            </button>
          </div>
          <p style={{ color: "var(--muted)" }}>
            {Math.round(selected.calories)} {t("calories")} · {Math.round(selected.protein)}g {t("protein")}
          </p>

          <h3>{t("meals")}</h3>
          {selected.entries.length === 0 ? (
            <p style={{ color: "var(--muted)" }}>{t("noWorkoutsToday")}</p>
          ) : (
            selected.entries.map((e) => (
              <div key={e.id} style={{ padding: "4px 0", borderTop: "0.5px solid var(--border)" }}>
                <strong>{e.name}</strong> — {Math.round(e.calories)} kcal, {Math.round(e.protein)}g
              </div>
            ))
          )}

          <h3>{t("workouts")}</h3>
          {selected.workouts.length === 0 ? (
            <p style={{ color: "var(--muted)" }}>{t("noWorkoutsToday")}</p>
          ) : (
            selected.workouts.map((w) => (
              <div key={w.id} style={{ padding: "4px 0", borderTop: "0.5px solid var(--border)" }}>
                <strong>{w.type}</strong> — {Math.round(w.duration / 60)} min
                {w.calories != null && `, ${Math.round(w.calories)} kcal`}
              </div>
            ))
          )}
        </div>
      )}
    </main>
  );
}

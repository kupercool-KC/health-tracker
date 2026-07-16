"use client";

/**
 * Daily/weekly totals for nutrition and workouts, read directly from
 * Firestore with the signed-in user's credentials.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/firebase/useAuth";
import {
  bucketByDay,
  getNutritionSince,
  getWorkoutsSince,
  startOfDayIso,
  type DayTotals,
} from "@/lib/dashboard/queries";

const WINDOW_DAYS = 7;

export default function Dashboard() {
  const { user, loading: authLoading } = useAuth();
  const [days, setDays] = useState<DayTotals[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const uid = user.uid;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const sinceIso = startOfDayIso(WINDOW_DAYS - 1);
        const [nutrition, workouts] = await Promise.all([
          getNutritionSince(uid, sinceIso),
          getWorkoutsSince(uid, sinceIso),
        ]);
        if (!cancelled) setDays(bucketByDay(nutrition, workouts, WINDOW_DAYS));
      } catch (err) {
        if (!cancelled) setError(String(err instanceof Error ? err.message : err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (authLoading || (loading && !error)) {
    return (
      <main>
        <p style={{ color: "var(--muted)" }}>Loading…</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main>
        <h1>Dashboard</h1>
        <p style={{ color: "var(--muted)" }}>
          <Link href="/">Sign in</Link> to see your totals.
        </p>
      </main>
    );
  }

  const week = days.reduce(
    (acc, d) => ({
      calories: acc.calories + d.calories,
      protein: acc.protein + d.protein,
      workoutMinutes: acc.workoutMinutes + d.workoutMinutes,
      workoutKcal: acc.workoutKcal + d.workoutKcal,
    }),
    { calories: 0, protein: 0, workoutMinutes: 0, workoutKcal: 0 },
  );
  const today = days[days.length - 1];

  return (
    <main>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1>Dashboard</h1>
        <Link href="/" style={{ color: "var(--accent)" }}>
          ← Log food
        </Link>
      </div>

      {error && <p style={{ color: "#ff6b6b" }}>{error}</p>}

      <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 16 }}>
        <StatCard label="Today" calories={today?.calories ?? 0} protein={today?.protein ?? 0} />
        <StatCard
          label={`Last ${WINDOW_DAYS} days`}
          calories={week.calories}
          protein={week.protein}
          sub={`${Math.round(week.workoutMinutes)} min · ${Math.round(week.workoutKcal)} kcal workouts`}
        />
      </section>

      <h2 style={{ marginTop: 32 }}>Daily breakdown</h2>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ color: "var(--muted)", textAlign: "left" }}>
            <th style={{ padding: 8 }}>Date</th>
            <th style={{ padding: 8 }}>Calories</th>
            <th style={{ padding: 8 }}>Protein</th>
            <th style={{ padding: 8 }}>Workout</th>
          </tr>
        </thead>
        <tbody>
          {[...days].reverse().map((d) => (
            <tr key={d.date} style={{ borderTop: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>{d.date}</td>
              <td style={{ padding: 8 }}>{Math.round(d.calories)} kcal</td>
              <td style={{ padding: 8 }}>{Math.round(d.protein)} g</td>
              <td style={{ padding: 8 }}>
                {d.workoutMinutes > 0 ? `${Math.round(d.workoutMinutes)} min` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

function StatCard({
  label,
  calories,
  protein,
  sub,
}: {
  label: string;
  calories: number;
  protein: number;
  sub?: string;
}) {
  return (
    <div style={{ padding: 16, borderRadius: 8, background: "var(--panel)", border: "1px solid var(--border)" }}>
      <div style={{ color: "var(--muted)" }}>{label}</div>
      <div style={{ fontSize: 24 }}>{Math.round(calories)} kcal</div>
      <div style={{ color: "var(--muted)" }}>{Math.round(protein)} g protein</div>
      {sub && <div style={{ color: "var(--muted)", marginTop: 4, fontSize: 13 }}>{sub}</div>}
    </div>
  );
}
